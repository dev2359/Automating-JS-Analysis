const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { OpenAI } = require('openai');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('❌ OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}
const openai = new OpenAI({ apiKey });

const COVERAGE_DIR = path.resolve(__dirname, 'coverage-results');
const OUTPUT_DIR = path.resolve(__dirname, 'ai-analysis-results');

// cafe24 optimizer.php 가 묶은 원본 JS 파일 경로 추출
function decodeCafe24Bundle(url) {
  try {
    const fn = new URL(url).searchParams.get('filename');
    if (!fn) return null;
    const std = fn.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - std.length % 4) % 4);
    const decoded = zlib.inflateRawSync(Buffer.from(padded, 'base64')).toString('binary');
    const flat = decoded.replace(/[\x0a\x0b\x0c\x15]/g, '');
    const files = flat.split(/js(?=\/home)/g).map((s, i, arr) => {
      if (i < arr.length - 1) return s + '.js';
      if (s.endsWith('.js')) return s;
      if (s.endsWith('js')) return s.slice(0, -2) + '.js';
      return s;
    }).filter(s => s.length > 0);
    return files;
  } catch {
    return null;
  }
}

function shortName(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
    return `${u.host}/${seg}`;
  } catch {
    return url;
  }
}

// 한 사이트의 여러 여정 결과를 URL 단위로 합집합(union) 한다.
// 정책: 한 여정에서라도 used 되면 used 로 간주 → unusedBytes 는 여정들 간 최소값,
// usedBytes 는 최대값. totalBytes 는 가장 큰 값으로 통일 (보통 동일).
function unionJourneys(journeyResults, kind /* 'js' | 'css' */) {
  const byUrl = new Map();
  const seenJourneysByUrl = new Map();
  for (const jr of journeyResults) {
    const entries = jr[kind] || [];
    for (const e of entries) {
      const cur = byUrl.get(e.url);
      const journeys = seenJourneysByUrl.get(e.url) || [];
      journeys.push(jr.journey.id);
      seenJourneysByUrl.set(e.url, journeys);
      if (!cur) {
        byUrl.set(e.url, { ...e });
      } else {
        cur.unusedBytes = Math.min(cur.unusedBytes, e.unusedBytes);
        cur.usedBytes = Math.max(cur.usedBytes, e.usedBytes);
        cur.totalBytes = Math.max(cur.totalBytes, e.totalBytes);
      }
    }
  }
  // 비율 재계산 + 어떤 여정에서 등장했는지 메타 추가
  const out = [];
  for (const [url, e] of byUrl) {
    e.unusedPercentage = ((e.unusedBytes / Math.max(1, e.totalBytes)) * 100).toFixed(2) + '%';
    e.observedInJourneys = [...new Set(seenJourneysByUrl.get(url))];
    out.push(e);
  }
  return out;
}

function pickTop(entries, n) {
  return entries
    .filter(d => d.unusedBytes > 0)
    .sort((a, b) => b.unusedBytes - a.unusedBytes)
    .slice(0, n)
    .map(d => {
      const bundled = d.url.includes('optimizer.php') ? decodeCafe24Bundle(d.url) : null;
      return {
        name: shortName(d.url),
        totalKB: +(d.totalBytes / 1024).toFixed(1),
        unusedKB: +(d.unusedBytes / 1024).toFixed(1),
        unusedPercentage: d.unusedPercentage,
        observedInJourneys: d.observedInJourneys,
        ...(bundled && bundled.length ? {
          bundledFileCount: bundled.length,
          bundledFiles: bundled.slice(0, 50),
        } : {}),
      };
    });
}

function totalsKB(entries) {
  const total = entries.reduce((s, e) => s + e.totalBytes, 0);
  const unused = entries.reduce((s, e) => s + e.unusedBytes, 0);
  return {
    totalKB: +(total / 1024).toFixed(1),
    unusedKB: +(unused / 1024).toFixed(1),
    unusedPercentage: ((unused / Math.max(1, total)) * 100).toFixed(2) + '%',
  };
}

async function analyzeSite(siteId, site, journeyResults) {
  const journeyIds = journeyResults.map(r => r.journey.id);
  const js = unionJourneys(journeyResults, 'js');
  const css = unionJourneys(journeyResults, 'css');

  const jsTop = pickTop(js, 10);
  const cssTop = pickTop(css, 5);
  const jsTotals = totalsKB(js);
  const cssTotals = totalsKB(css);

  const payload = {
    site: site.name,
    baseUrl: site.baseUrl,
    observedJourneys: journeyIds,
    summary: { js: jsTotals, css: cssTotals },
    topUnusedJs: jsTop,
    topUnusedCss: cssTop,
  };

  const prompt = `
다음은 "${site.name}" (${site.baseUrl}) 의 여러 사용자 여정 (${journeyIds.join(', ')}) 에서
측정한 JS·CSS 커버리지를 합집합(한 여정에서라도 used 면 used 로 간주) 한 결과입니다.
즉, 아래 "미사용" 으로 분류된 코드는 측정한 여정 어디에서도 실행되지 않은 진짜 dead code 후보입니다.
용량 단위는 KB(킬로바이트)입니다.

${JSON.stringify(payload, null, 2)}

위 데이터를 바탕으로 Slack 한 섹션에 들어갈 짧은 분석 리포트를 한국어로 작성해 주세요.
규칙:
- 파일을 도메인으로 뭉뚱그리지 말고, name 필드의 "host/파일명" 형태를 그대로 사용해 식별 가능하게 표기.
- 용량은 unusedKB / totalKB 값을 KB 단위로 표기.
- bundledFiles 가 있는 항목은 cafe24 optimizer.php 가 여러 원본 JS 를 묶어 서빙하는 케이스이므로, 묶여있는 대표 파일 5~10개를 basename 만 짧게 나열해 어떤 모듈들이 들어있는지 보여주세요.
- JS 와 CSS 를 분리해서 표기하세요. CSS 가 비어있으면 그 섹션은 생략.

리포트 구성:

*📦 ${site.name}* — ${journeyIds.length}개 여정 합집합 기준 미사용 JS ${jsTotals.unusedKB} KB (${jsTotals.unusedPercentage}), CSS ${cssTotals.unusedKB} KB (${cssTotals.unusedPercentage})
_측정 여정: ${journeyIds.join(', ')}_

*🚨 미사용 JS Top 5*
(각 항목: name + 미사용 % + 미사용 KB / 전체 KB. bundledFiles 있으면 "└ 묶인 파일: a.js, b.js ... (총 N개)" 한 줄 추가)

*🎨 미사용 CSS Top 3* (CSS 데이터 있을 때만)

*🔍 짧은 한 줄 요약*
(여러 여정 합집합에도 안 쓰이는 가장 큰 낭비 항목 한 줄로)
`;

  console.log(`🤖 [${siteId}] OpenAI 분석 요청 중... (${journeyIds.length}개 여정 합집합)`);
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });
  const text = response.choices[0].message.content || '';
  console.log(`✨ [${siteId}] 결과 길이: ${text.length}자`);
  return text;
}

async function main() {
  if (!fs.existsSync(COVERAGE_DIR)) {
    console.error(`❌ coverage-results 디렉토리가 없습니다: ${COVERAGE_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(COVERAGE_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.error('❌ 분석할 사이트 커버리지 결과가 없습니다.');
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 사이트 id 기준으로 grouping. 파일명은 {siteId}__{journeyId}.json 형식.
  const bySite = new Map();
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(COVERAGE_DIR, f), 'utf-8'));
    if (!data.site || !data.js) {
      console.warn(`⚠️ ${f}: 예상 구조와 다름, 스킵`);
      continue;
    }
    // 구버전 호환: journey 필드 없으면 default 로 부여
    if (!data.journey) data.journey = { id: 'default', name: 'default' };

    const group = bySite.get(data.site.id) || { site: data.site, journeys: [] };
    group.journeys.push(data);
    bySite.set(data.site.id, group);
  }

  console.log(`📦 ${bySite.size}개 사이트, 총 ${files.length}개 여정 결과 로드`);

  let okCount = 0;
  for (const [siteId, group] of bySite) {
    try {
      const text = await analyzeSite(siteId, group.site, group.journeys);
      fs.writeFileSync(path.join(OUTPUT_DIR, `${siteId}.txt`), text);
      okCount++;
    } catch (e) {
      console.error(`❌ [${siteId}] 분석 실패:`, e.message);
    }
  }
  console.log(`✅ ${okCount}/${bySite.size} 사이트 분석 완료 → ${OUTPUT_DIR}`);
  if (okCount === 0) process.exit(1);
}

main();
