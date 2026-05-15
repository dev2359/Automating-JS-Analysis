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

// cafe24 의 optimizer.php / optimizer_user.php 가 묶은 원본 파일 경로 추출.
// 두 번들 모두 URL-safe base64 + raw DEFLATE 인코딩 + control byte 기반 마커 사용:
//   \x15 (NAK)  : record separator (파일 사이)
//   \x0a (LF)   : path 안의 '-' 를 인코딩 (예: ec-base-layer → ec\nbase\nlayer)
//   \x0b (VT)   : prefix 변경 marker
//   \x0c (FF)   : 확장자 marker (path 와 ext 사이)
function decodeCafe24Bundle(url) {
  try {
    const u = new URL(url);
    const fn = u.searchParams.get('filename');
    if (!fn) return null;
    const type = (u.searchParams.get('type') || 'js').toLowerCase();
    const std = fn.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - std.length % 4) % 4);
    const decoded = zlib.inflateRawSync(Buffer.from(padded, 'base64')).toString('binary');

    const records = decoded.split('\x15').filter(s => s.length > 0);
    return records.map(rec => {
      let p = rec
        .replace(/\x0a/g, '-')   // path 안의 '-' 복원
        .replace(/[\x0b\x0c]/g, ''); // prefix/ext marker 제거
      // optimizer_user.php 케이스: 'sde' (cafe24 internal root) prefix 제거
      if (p.startsWith('sde')) p = p.slice(3);
      // 끝에 확장자가 . 없이 붙어있으면 . 추가
      if (p.endsWith(type)) p = p.slice(0, -type.length) + '.' + type;
      return p;
    }).filter(s => s.length > 0);
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

// URL 을 정리 가능성 기준 카테고리로 분류한다.
// 카페24 임대형 호스팅에서는 시스템 표준 스크립트(Front/, async/, lib/Uipack/ 등)는
// 직접 코드 수정이 불가능하고 admin 토글만 가능. 외부 트래커/라이브러리/사용자 커스텀
// 스크립트는 admin 에서 추가/제거하거나 직접 수정 가능.
const TRACKER_HOSTS = new Set([
  'www.googletagmanager.com', 'googletagmanager.com',
  'analytics.tiktok.com', 'analytics.google.com',
  'cdn.channel.io',
  'static.hackle.io',
  'sdk.bigin.io',
  'connect.facebook.net',
  'cdn.snapfit.co.kr',
  'developers.kakao.com', 'pf.kakao.com', 't1.kakaocdn.net',
  'cdn.taboola.com',
]);
const LIB_CDN_HOSTS = new Set([
  'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'code.jquery.com',
]);
const FONT_HOSTS = new Set([
  'fonts.googleapis.com', 'fonts.gstatic.com',
  'use.typekit.net', 'fonts.cdnfonts.com',
]);
const CAFE24_HOST_KEYWORDS = ['cafe24.com', 'cafe24img', 'echosting', 'poxo.com'];

function categorize(url) {
  let u;
  try { u = new URL(url); } catch { return 'unknown'; }
  const host = u.host;

  if (TRACKER_HOSTS.has(host)) return 'external_tracker';
  if (LIB_CDN_HOSTS.has(host)) return 'external_lib';
  if (FONT_HOSTS.has(host)) return 'external_font';
  if (CAFE24_HOST_KEYWORDS.some(k => host.includes(k))) return 'cafe24_system';

  // 사이트 자체 호스팅 — path 로 세분화
  const pathname = u.pathname;
  // cafe24 표준 스크립트 번들 (Front/, async/, lib/ 등 system 모듈 묶음). 직접 수정 불가.
  if (pathname.includes('/ind-script/optimizer.php')) return 'cafe24_system';
  // cafe24 system app (Eclog, cid.generate 등)
  if (pathname.startsWith('/app/')) return 'cafe24_system';
  // optimizer_user.php: admin 에서 사용자가 추가한 외부 CSS/JS 의 묶음
  if (pathname.includes('/ind-script/optimizer_user.php')) return 'skin_user_added';
  // /web/upload/: admin 에서 업로드한 사용자 JS 파일
  if (pathname.startsWith('/web/upload/')) return 'skin_uploaded';
  // .html 페이지 URL 의 inline 스크립트: 스킨 편집기에서 HTML 편집 시 들어가는 JS
  if (pathname.endsWith('.html')) return 'skin_inline_html';

  // 그 외 사이트 자체 호스팅 — 스킨/보드/이벤트 등 사용자 커스텀
  return 'skin_custom';
}

const CATEGORY_LABELS = {
  external_tracker: '🔌 외부 트래커/SDK (admin → 디자인 편집 → 추가 스크립트)',
  external_lib: '📚 외부 라이브러리 CDN (사용자 추가)',
  external_font: '🔤 외부 폰트',
  skin_uploaded: '📁 /web/upload/ 업로드 파일 (admin 디자인 편집기에서 교체)',
  skin_user_added: '🧩 optimizer_user.php (admin에서 사용자가 추가한 외부 CSS/JS 묶음)',
  skin_inline_html: '📝 스킨 HTML 안 inline 스크립트 (admin 디자인 편집기)',
  skin_custom: '🎨 사이트 커스텀 스크립트 (스킨/보드/이벤트)',
  cafe24_system: '🏛️ cafe24 시스템 (직접 수정 불가, admin 토글만)',
  unknown: '❓ 분류 불가',
};

// 사용자가 admin/스킨 편집기에서 직접 정리·교체·수정 가능한 카테고리들
const USER_CONTROLLABLE = [
  'external_tracker', 'external_lib', 'external_font',
  'skin_uploaded', 'skin_user_added', 'skin_inline_html', 'skin_custom',
];

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

function toEntryView(d) {
  const category = categorize(d.url);
  // optimizer.php (cafe24 system 번들) 와 optimizer_user.php (사용자 스킨 번들) 둘 다 디코딩
  const isCafe24Bundle = d.url.includes('/ind-script/optimizer.php') || d.url.includes('/ind-script/optimizer_user.php');
  const bundled = isCafe24Bundle ? decodeCafe24Bundle(d.url) : null;
  return {
    name: shortName(d.url),
    url: d.url,
    category,
    totalKB: +(d.totalBytes / 1024).toFixed(1),
    unusedKB: +(d.unusedBytes / 1024).toFixed(1),
    unusedPercentage: d.unusedPercentage,
    observedInJourneys: d.observedInJourneys,
    ...(bundled && bundled.length ? {
      bundledFileCount: bundled.length,
      bundledFiles: bundled,
    } : {}),
  };
}

function pickTopByCategory(entries, categories, n) {
  return entries
    .filter(d => d.unusedBytes > 0)
    .map(toEntryView)
    .filter(e => categories.includes(e.category))
    .sort((a, b) => b.unusedKB - a.unusedKB)
    .slice(0, n);
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

  // 사용자가 직접 정리할 수 있는 카테고리 위주로 Top 추출
  const jsUserControllable = pickTopByCategory(js, USER_CONTROLLABLE, 10);
  const cssUserControllable = pickTopByCategory(css, USER_CONTROLLABLE, 5);

  // cafe24 시스템 (참고용, 직접 수정 불가)
  const jsCafe24 = pickTopByCategory(js, ['cafe24_system'], 5);

  const jsTotals = totalsKB(js);
  const cssTotals = totalsKB(css);

  // 카테고리별 미사용 KB 합계 (요약)
  const byCategoryUnused = {};
  for (const e of js) {
    if (e.unusedBytes <= 0) continue;
    const cat = categorize(e.url);
    byCategoryUnused[cat] = (byCategoryUnused[cat] || 0) + e.unusedBytes;
  }
  const categoryBreakdown = Object.entries(byCategoryUnused)
    .map(([cat, bytes]) => ({ category: cat, label: CATEGORY_LABELS[cat], unusedKB: +(bytes / 1024).toFixed(1) }))
    .sort((a, b) => b.unusedKB - a.unusedKB);

  const payload = {
    site: site.name,
    baseUrl: site.baseUrl,
    observedJourneys: journeyIds,
    summary: { js: jsTotals, css: cssTotals },
    jsUnusedByCategory: categoryBreakdown,
    userControllableJs: jsUserControllable,    // ← 메인 분석 대상
    userControllableCss: cssUserControllable,
    cafe24SystemJs: jsCafe24,                  // ← 참고용
  };

  const prompt = `
당신은 cafe24 임대형 쇼핑몰 운영자를 돕는 JS/CSS 미사용 분석 전문가입니다.

# 가장 중요한 원칙

cafe24 임대형 호스팅에서 사용자가 admin/스킨 편집기로 직접 수정 가능한 영역은 명확히 제한적입니다:

✅ 사용자가 직접 수정·제거 가능:
- 외부 트래커/SDK (admin → 디자인 → 스크립트 추가 영역에서 추가/제거)
- 외부 라이브러리 CDN (cdnjs, jsdelivr 등 사용자가 추가한 것)
- /web/upload/ 에 업로드한 사용자 JS 파일
- optimizer_user.php 묶음 (admin 에서 추가한 외부 스크립트 모음)
- 스킨 HTML 페이지 안의 inline 스크립트 (.html URL — admin → 디자인 → HTML 편집)
- 스킨/보드/이벤트 페이지의 사이트 커스텀 스크립트

❌ 사용자가 직접 수정 불가 (참고만):
- cafe24 표준 번들 optimizer.php — Front/, async/, lib/Uipack/ 등 cafe24 system 모듈만 묶여있음
- /app/Eclog/ 같은 cafe24 system app
- → 이 영역의 모듈을 개별 파일명으로 나열하지 마세요. 운영자가 손댈 수 없는 코드입니다. cafe24 admin 의 "기능 사용/미사용" 토글로 일부만 제어 가능하다는 점만 언급.

# 측정 컨텍스트

대상: "${site.name}" (${site.baseUrl})
측정 여정 (${journeyIds.length}개): ${journeyIds.join(', ')}
방문 페이지: 메인, 상품목록, 상품상세, 장바구니, 주문진입, 검색결과, 모바일 동일 흐름
측정 안 한 페이지(참고): 마이페이지, 회원가입/로그인, 게시판, 이벤트, 펀딩

# 측정 데이터 (KB 단위)

${JSON.stringify(payload, null, 2)}

# 출력 형식 (Slack mrkdwn, 한국어)

메인 섹션은 userControllableJs / userControllableCss 입니다. cafe24 시스템은 마지막 1줄 참고만.

*📦 ${site.name}* — 미사용 JS ${jsTotals.unusedKB} KB (${jsTotals.unusedPercentage}), CSS ${cssTotals.unusedKB} KB (${cssTotals.unusedPercentage})
_측정 여정: ${journeyIds.join(', ')}_

*🎯 운영자가 admin/스킨 편집기로 직접 정리 가능한 미사용 JS Top 10*
**중요**: \`celladix.co.kr/optimizer_user.php\` 같은 번들 단위로 표기하지 말고, 그 안의 \`bundledFiles\` 에 들어있는 **개별 스킨 파일 path 를 메인 항목** 으로 노출하세요. (예: \`design/skin13/js/cart.js\`, \`design/skin13/js/promotion.js\`). 번들 전체 미사용 KB 는 한 줄 요약으로만 언급.

userControllableJs 의 항목들을 다음 규칙으로 펼쳐 주세요:
- bundledFiles 가 있는 항목 (optimizer_user.php) → bundledFiles 의 path 들을 측정 여정 정보와 매칭해서 안 쓰일 가능성 높은 파일을 **개별 list item** 으로 추출. 각 항목: \`path\` — 추정 용도 — 편집 위치
- bundledFiles 가 없는 항목 (외부 트래커, 외부 라이브러리 등) → name + unusedKB / totalKB + 편집 위치
- 동일 path 중복 금지, 최대 10개

편집 위치 가이드:
- skin_user_added bundledFiles 내부 (design/skin13/js/, design/skin13/css/) → "admin > 디자인 > HTML/CSS 편집기 > 해당 스킨 파일"
- skin_inline_html (.html URL) → "admin > 디자인 > HTML 편집 > 해당 페이지 inline \`<script>\`"
- skin_uploaded (/web/upload/) → "admin > 디자인 > 파일관리"
- external_tracker → "admin > 쇼핑몰 설정 > 마케팅 / 외부 스크립트 추가 영역"
- external_lib/font → "스킨 HTML 의 \`<script src>\` / \`<link>\` 태그 직접 제거"
- skin_custom → "스킨/보드/이벤트 HTML 직접 편집"

각 사이트의 \`optimizer_user.php\` 번들이 측정 여정에서 X KB 미사용이라는 사실은 항목 마지막에 한 줄 요약으로:
\`└ (참고) optimizer_user.php 번들 전체 미사용 X KB. 개별 파일 단위 정확 측정은 cafe24 번들 구조상 불가, 위 추정은 path + 측정 여정 기반.\`

*🎨 직접 정리 가능한 미사용 CSS Top 5*
JS 와 같은 규칙: optimizer_user.php bundledFiles 안의 개별 css path 를 메인 항목으로. 번들 단위로 묶지 말 것.

*🏛️ cafe24 시스템 모듈 (참고, 직접 수정 불가)*
"cafe24 표준 번들에서 약 X KB 미사용. 이 영역은 임대형 호스팅에서 admin 의 '쇼핑몰 기능 사용/미사용' 토글로만 제어 가능하며 개별 파일은 손댈 수 없음." — 한 줄로만. **cafe24 시스템 모듈의 개별 파일 path 를 절대 나열하지 마세요.**

*💡 오늘 바로 실행 가능한 정리 액션 3개*
구체적으로 어디 가서 무엇을 끄면 몇 KB 절감되는지 형식. 예:
- "admin > 디자인 > HTML 편집 > 상품 상세 페이지 > inline 스크립트 정리 → X KB 절감"
- "TikTok 픽셀을 사용하지 않는다면 admin > 쇼핑몰 설정 > 마케팅 > TikTok 픽셀 비활성화 → Y KB 절감"
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
