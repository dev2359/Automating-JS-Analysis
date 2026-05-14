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
// filename 파라미터는 URL-safe base64 + raw DEFLATE 압축이고, 압축 해제 결과는
// 컨트롤 바이트(0x0a/0x0b/0x0c/0x15)로 prefix-compression 한 경로 스트림
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

async function analyzeSite(siteResult) {
  const { site, js, css } = siteResult;
  const jsTop = pickTop(js, 10);
  const cssTop = pickTop(css, 5);
  const jsTotals = totalsKB(js);
  const cssTotals = totalsKB(css);

  const payload = {
    site: site.name,
    baseUrl: site.baseUrl,
    summary: { js: jsTotals, css: cssTotals },
    topUnusedJs: jsTop,
    topUnusedCss: cssTop,
  };

  const prompt = `
다음은 "${site.name}" (${site.baseUrl}) 의 구매 여정에서 측정한 JS 및 CSS 커버리지 데이터입니다.
용량 단위는 KB(킬로바이트)입니다.

${JSON.stringify(payload, null, 2)}

위 데이터를 바탕으로 Slack 한 섹션에 들어갈 짧은 분석 리포트를 한국어로 작성해 주세요.
규칙:
- 파일을 도메인으로 뭉뚱그리지 말고, name 필드의 "host/파일명" 형태를 그대로 사용해 식별 가능하게 표기.
- 용량은 unusedKB / totalKB 값을 KB 단위로 표기. (예: "1299.7 KB / 1693.0 KB 미사용")
- bundledFiles 가 있는 항목은 cafe24 optimizer.php 가 여러 원본 JS 를 묶어 서빙하는 케이스이므로, 묶여있는 대표 파일 5~10개를 basename 만 짧게 나열해 어떤 모듈들이 들어있는지 보여주세요.
- JS 와 CSS 를 분리해서 표기하세요. CSS 가 비어있으면 그 섹션은 생략.

리포트 구성 (이 사이트 1개에 대해서만 작성):

*📦 ${site.name}* — 전체 미사용 JS ${jsTotals.unusedKB} KB (${jsTotals.unusedPercentage}), CSS ${cssTotals.unusedKB} KB (${cssTotals.unusedPercentage})

*🚨 미사용 JS Top 5*
(각 항목: name + 미사용 % + 미사용 KB / 전체 KB. bundledFiles 가 있으면 "└ 묶인 파일: a.js, b.js ... (총 N개)" 한 줄 추가)

*🎨 미사용 CSS Top 3* (CSS 데이터 있을 때만)
(각 항목: name + 미사용 % + 미사용 KB / 전체 KB)

*🔍 짧은 한 줄 요약*
(이 사이트에서 어떤 모듈/트래커가 가장 큰 낭비인지 한 줄로)
`;

  console.log(`🤖 [${site.id}] OpenAI 분석 요청 중...`);
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });
  const text = response.choices[0].message.content || '';
  console.log(`✨ [${site.id}] 결과 길이: ${text.length}자`);
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

  let okCount = 0;
  for (const f of files) {
    const filePath = path.join(COVERAGE_DIR, f);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!data.site || !data.js) {
      console.warn(`⚠️ ${f}: 예상 구조와 다름, 스킵`);
      continue;
    }
    try {
      const text = await analyzeSite(data);
      fs.writeFileSync(path.join(OUTPUT_DIR, `${data.site.id}.txt`), text);
      okCount++;
    } catch (e) {
      console.error(`❌ [${data.site.id}] 분석 실패:`, e.message);
    }
  }
  console.log(`✅ ${okCount}/${files.length} 사이트 분석 완료 → ${OUTPUT_DIR}`);
  if (okCount === 0) process.exit(1);
}

main();
