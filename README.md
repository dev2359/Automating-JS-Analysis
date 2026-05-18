# Automating-JS-Analysis

여러 cafe24 임대형 쇼핑몰의 **JS / CSS 미사용 코드**를 매일 자동으로 측정·분석해 Slack 으로 리포트하는 GitHub Actions 파이프라인.

## 무엇을 측정하는가

각 사이트에서 다음 세 가지 사용자 여정을 Playwright 로 자동 실행하고, **JS와 CSS 양쪽의 byte 단위 coverage**를 측정합니다.

| 여정 | 흐름 |
|---|---|
| `purchase` (PC) | 메인 → 카테고리 (`/product/list.html`) → 상품 상세 → 장바구니 → 주문 진입 |
| `search` | 메인 → 검색 결과 (`/product/search.html?keyword=...`) → 상품 상세 |
| `mobile` | 모바일 viewport (390×844) + 구매 흐름 재사용 |

같은 사이트의 여러 여정 결과는 **URL 단위 합집합** 으로 합쳐서, 한 여정에서라도 used 된 코드는 used 로 처리합니다 (`min(unusedBytes)`). 합집합 후에도 미사용으로 분류된 코드 = "측정한 여정 어디에서도 호출되지 않은 dead code 후보".

## 파이프라인 단계

매일 `00:00 UTC` (KST 09:00) 또는 `workflow_dispatch` 수동 실행:

1. **🚀 1단계 — Playwright 측정** — 사이트 × 여정 조합으로 동적 `test()` 생성, `coverage-results/{siteId}__{journeyId}.json` 저장
2. **🤖 2단계 — OpenAI 분석** — 사이트별 합집합·카테고리 분류·cafe24 번들 디코딩 후 GPT-4o 에 사이트당 1회 호출. 결과를 `ai-analysis-results/{siteId}.txt` 저장. 동시에 시계열 `history/{YYYY-MM-DD}.json` snapshot 생성
3. **📅 history 자동 commit** — 오늘 snapshot 을 main 브랜치에 자동 commit & push (시계열 누적)
4. **📤 아티팩트 업로드** — `coverage-results/`, `ai-analysis-results/`, `test-results/`, `playwright-report/` 를 14일 보관
5. **💬 Slack 전송** — 사이트별 section block 으로 한 메시지에 발송

## 디렉토리 구조

```
.
├── sites.config.js                 # 사이트 정의 (selector, baseUrl, 검색 키워드)
├── playwright.config.ts            # 1920x1080 desktop UA / ko-KR / 90s timeout
├── tests/
│   └── full-flow-coverage.spec.ts  # journey 추상화 + 사이트×여정 동적 test()
├── analyze-js.js                   # union, 카테고리 분류, cafe24 번들 디코더, 시계열 비교, GPT 호출
├── send-slack.js                   # ai-analysis-results 를 한 메시지 section blocks 로 발송
├── history/                        # 매일 누적되는 시계열 snapshot (git 추적)
│   └── 2026-05-15.json
├── coverage-results/               # 1단계 산출물 (gitignored, 아티팩트로 보관)
├── ai-analysis-results/            # 2단계 산출물 (gitignored, 아티팩트로 보관)
└── .github/workflows/
    └── unused-js-check.yml
```

## 새 사이트 추가하기

cafe24 솔루션 사이트면 `sites.config.js` 에 객체 하나만 추가하면 끝입니다.

```js
{
  id: 'new-shop',
  name: '예시샵',
  baseUrl: 'https://example.co.kr/',
  selectors: {
    // 결정론적이고 selector 변경에 강한 list URL 직접 goto 권장
    productListUrl: 'https://example.co.kr/product/list.html?cate_no=N',
    // (대안) productListUrl 없이 메뉴 클릭 기반
    // category: { role: 'link', name: 'ALL', exact: true },
    productLink: 'a[href*="/product/detail"]',
    cartButton: 'text="장바구니"',
    basketUrl: 'https://example.co.kr/order/basket.html',
    orderButton: 'text="전체상품주문", text="주문하기", a:has-text("주문하기")',
  },
  // 검색 여정용 키워드 (없으면 검색 여정 자동 스킵)
  searchKeyword: '비타민',
}
```

`cate_no` 는 사이트의 BEST/NEW 카테고리 URL 에서 확인. cafe24 의 `/product/cate_list.html` (그룹 페이지) 가 아니라 반드시 `/product/list.html` 로 가야 상품 detail 링크가 노출됩니다.

## 새 여정 추가하기

`tests/full-flow-coverage.spec.ts` 의 `journeys` 배열에 함수 1개 추가:

```ts
{
  id: 'review',
  name: '리뷰 게시판 여정',
  isApplicable: (site) => /* 조건 */ true,
  run: async (page, site) => {
    await page.goto(site.baseUrl + 'board/product/list.html');
    // ...
  },
},
```

추가한 여정은 모든 사이트에 자동으로 매핑되어 사이트 × 여정 조합으로 test() 가 생성됩니다.

## 카테고리 분류 (운영자 관점)

운영자가 admin/스킨 편집기로 직접 정리·교체할 수 있는지에 따라 분류합니다.

| 카테고리 | 예시 | 정리 위치 |
|---|---|---|
| `external_tracker` | channel.io, googletagmanager, TikTok, Hackle, Bigin, Facebook | admin > 쇼핑몰 설정 > 마케팅 / 외부 스크립트 추가 영역 |
| `external_lib` | cdnjs, jsdelivr, unpkg, code.jquery | 스킨 HTML 의 `<script src>` 직접 제거 |
| `external_font` | Google Fonts, Typekit, cdnfonts | 스킨 HTML 의 `<link>` 직접 제거 |
| `skin_uploaded` | `/web/upload/...js` | admin > 디자인 > 파일관리 |
| `skin_user_added` | `optimizer_user.php` 번들 (admin 에서 사용자가 추가한 외부 스크립트 모음) | admin > 디자인 > 스크립트/스타일 추가 영역 |
| `skin_inline_html` | `*.html` URL 안의 inline `<script>` | admin > 디자인 > HTML 편집 |
| `skin_custom` | 스킨/보드/이벤트 HTML 의 사이트 자체 JS | 스킨 직접 편집 |
| `cafe24_system` | `optimizer.php` 번들 내부, `/app/` 경로 | **직접 수정 불가** — admin 기능 토글만 |

Slack 리포트의 메인 항목은 **사용자 제어 가능** 카테고리만 노출되고, `cafe24_system` 은 마지막에 한 줄 참고로만 표시됩니다.

## cafe24 번들 디코딩

`optimizer.php` 와 `optimizer_user.php` 의 `filename` 쿼리 파라미터는 cafe24 가 묶은 원본 파일 path 목록을 **URL-safe base64 + raw DEFLATE 압축** 으로 인코딩한 결과입니다. 추가로 다음 control byte 마커를 사용합니다.

| 바이트 | 역할 |
|---|---|
| `\x15` (NAK) | record separator (파일 사이) |
| `\x0a` (LF) | path 안의 `-` 인코딩 (예: `ec-base-layer` → `ec\nbase\nlayer`) |
| `\x0b` (VT) | prefix 변경 marker |
| `\x0c` (FF) | path / 확장자 사이 marker |

`analyze-js.js` 의 `decodeCafe24Bundle()` 이 두 번들 모두 디코딩해 다음 형태로 풀어냅니다:

- `optimizer.php` → `framework/resource/js/i18n.js`, `program/app/Shop/Resource/js/Front/basket.js` 같은 cafe24 system 모듈
- `optimizer_user.php` → `design/skin13/js/detail.js`, `design/skin13/css/module/myshop/wishlist.css` 같은 **운영자 편집 가능 스킨 파일**

> ⚠️ 정확도 한계: cafe24 번들 응답에 파일 경계 마커가 없어 **번들 내 어떤 byte 가 어떤 원본 파일에 속하는지 byte 단위 매핑은 불가능**. 번들 전체의 used/unused 만 측정되고, "이 파일이 안 쓰임" 판단은 path 패턴과 측정 여정 정보를 기반으로 한 GPT 추론입니다. 100% 보장 아님.

## 시계열 추적

매일 cron 끝에 사이트별 요약과 외부 트래커 entries 를 `history/{YYYY-MM-DD}.json` 으로 저장하고 main 브랜치에 자동 commit 합니다. 다음 실행 시 7일 전 데이터와 비교해 외부 트래커의 미사용 KB 가 30 KB 이상 변화한 항목을 **`⚠️ 7일 전 대비 변화`** 섹션으로 Slack 리포트에 자동 포함합니다.

- 첫 1주일은 비교 데이터가 없어 변화 섹션이 비어있음
- 변화 형태: `increased` (미사용량 +), `decreased` (미사용량 -), `new`, `removed`
- 비교 정밀도는 일(day) 단위 — 더 정밀하게 보려면 cron 간격을 줄이면 됨

## 환경 변수 (GitHub Secrets)

| 이름 | 용도 |
|---|---|
| `OPENAI_API_KEY` | OpenAI Chat Completions (`gpt-4o`) 호출 |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook. 폐기되면 401/404 — admin 에서 새로 발급 후 secret 갱신 |

## 로컬에서 수동 실행

```bash
npm install
npx playwright install --with-deps chromium
npx playwright test tests/full-flow-coverage.spec.ts --project=chromium
OPENAI_API_KEY=... node analyze-js.js
SLACK_WEBHOOK_URL=... node send-slack.js
```

## 워크플로 수동 실행 (gh CLI)

```bash
gh workflow run unused-js-check.yml --ref main
gh run watch <run-id> --exit-status
gh run download <run-id> --name coverage-and-analysis
```

## 안정성 관련 결정 사항

- **사이트 × 여정 단위 격리**: 한 조합이 실패해도 다른 조합은 계속 진행 (Playwright `test()` 단위)
- **product detail 진입은 href 추출 후 `page.goto`**: 캐러셀 hidden anchor click 이 page 를 닫는 cafe24 동작 우회
- **`state: 'attached'` 사용**: 캐러셀 / 슬라이더 안 hidden 요소도 찾아냄
- **메인 페이지 fallback**: list 페이지에서 상품 못 찾으면 메인의 BEST/NEW 섹션에서 재시도
- **`page.on('dialog')` 자동 dismiss**: native alert 로 page hang 방지
- **데스크탑 Chrome UA 흉내**: 일부 cafe24 사이트의 `HeadlessChrome` UA 차단 우회
- **120s test timeout, retry 2회**: 사이트 응답 지연 + 1·2차 시도 누적 여유
