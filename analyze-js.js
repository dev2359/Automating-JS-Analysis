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
        // cafe24 번들의 경우 묶인 원본 파일 전체 목록을 GPT 에게 전달.
        // (byte-level 매핑은 cafe24 가 marker 없이 concatenate 해서 불가능이라,
        // 대신 path 패턴 + 측정 여정 정보로 어떤 모듈이 안 쓰일지 추론)
        ...(bundled && bundled.length ? {
          bundledFileCount: bundled.length,
          bundledFiles: bundled,
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
당신은 cafe24 솔루션 쇼핑몰의 JS 미사용 분석 전문가입니다.

# 측정 컨텍스트

대상 사이트: "${site.name}" (${site.baseUrl})
측정된 사용자 여정 (${journeyIds.length}개):
${journeyIds.map(j => '- ' + j + ' 여정').join('\n')}

위 여정은 구체적으로 다음 페이지들을 방문합니다:
- 메인 페이지 (스크롤 끝까지)
- 상품 목록 페이지 (/product/list.html)
- 상품 상세 페이지 (/product/detail.html)
- 장바구니 페이지 (/order/basket.html)
- 결제/주문 시작 페이지
- 검색 결과 페이지 (/product/search.html)
- 모바일 뷰포트(390x844) 로 동일 흐름

측정에 포함되지 않은 일반적인 페이지들 (참고):
- 마이페이지(/myshop), 위시리스트, 주문 내역, 적립금/쿠폰 조회
- 로그인/회원가입(/member/login.html, /page/join.html)
- 게시판/리뷰/Q&A (/board/...)
- 이벤트 페이지 (/event/...)
- 펀딩/예약/특수 옵션 상품 페이지

# 측정 데이터 (KB 단위)

${JSON.stringify(payload, null, 2)}

# 주의사항 (매우 중요)

topUnusedJs 안의 "celladix.co.kr/optimizer.php" 같은 항목들은 **cafe24 가 100개+ 원본 JS 파일을 하나로 묶어 서빙하는 번들** 입니다. bundledFiles 필드에 그 안에 묶여있는 원본 파일 path 전체 목록이 들어있어요. cafe24 가 번들 응답에 파일 경계 마커를 안 넣어 byte-level 매핑은 불가능하지만, **bundledFiles 의 path 패턴 + 측정된 여정 정보를 종합하면 어떤 원본 파일이 측정 여정에서 거의 확실히 호출되지 않는지 추론 가능** 합니다.

# 출력 형식 (Slack mrkdwn, 한국어)

리포트는 cafe24 번들 단위가 아니라 **번들 안에서 추론된 개별 원본 파일** 을 메인 항목으로 노출해 주세요. "celladix.co.kr/optimizer.php — 77% 미사용" 같은 번들 단위 보고는 하지 마세요.

*📦 ${site.name}* — ${journeyIds.length}개 여정 합집합 기준 미사용 JS ${jsTotals.unusedKB} KB (${jsTotals.unusedPercentage}), CSS ${cssTotals.unusedKB} KB (${cssTotals.unusedPercentage})
_측정 여정: ${journeyIds.join(', ')}_

*🚨 측정 여정에서 호출되지 않을 가능성이 매우 높은 cafe24 모듈 Top 10*
(각 항목: bundledFiles 안의 path 에서 의미 있는 부분만 추출 — 예: "async/asyncWishList.js", "Front/New/Option/Extra/NewOptionExtraFunding.js" — + 어떤 페이지·기능에서만 쓸지 한 줄 추정)
1. {파일 path} — {추정 용도}
2. ...

*🌐 cafe24 번들 외부의 미사용 큰 파일 Top 3*
(topUnusedJs 항목 중 bundledFiles 가 없는 항목들 — 예: channel.io, googletagmanager, tiktok, bigin, hackle 등 외부 트래커/SDK)
1. {host/filename} — {unusedKB} KB / {totalKB} KB ({unusedPercentage} 미사용)
2. ...

*🎨 미사용 CSS Top 3* (CSS 데이터 있을 때만)
1. {host/filename} — {unusedKB} KB ({unusedPercentage} 미사용)

*💡 즉시 정리 효과가 큰 제안 (2~3줄)*
- cafe24 admin 의 스크립트 최적화 설정에서 빠질 수 있는 모듈군
- 또는 외부 트래커 중 정리해도 좋을 항목
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
