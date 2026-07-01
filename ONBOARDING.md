# 온보딩 가이드 (Automating-JS-Analysis)

> 이 프로젝트를 처음 맡는 개발자를 위한 인수인계 문서입니다.
> "무엇을 / 왜 / 어떻게" 를 먼저 이해하고, 마지막의 **이어서 할 수 있는 작업** 을 보면서 개발을 이어가세요.
> 코드 자체의 세부 스펙은 [README.md](README.md) 에 있으니 함께 보세요. 이 문서는 **맥락과 흐름** 에 집중합니다.

---

## 1. 이 프로젝트는 무엇인가

여러 **cafe24 임대형 쇼핑몰**의 **JS / CSS 미사용 코드(dead code)** 를 매일 자동으로 측정·분석해 **Slack** 으로 리포트하는 GitHub Actions 파이프라인입니다.

- 대상 사이트: 현재 3곳 — **메디온**(themedion), **셀라딕스**(celladix), **웰릿**(wellit)
- 실행 주기: 매일 `00:00 UTC` (KST 09:00) 자동 + 수동(`workflow_dispatch`)
- 결과물: 사이트별로 "운영자가 admin/스킨 편집기에서 직접 정리할 수 있는 미사용 코드" 를 Slack 리포트로 전달

### 왜 만들었나 (핵심 가치)

cafe24 임대형 쇼핑몰은 스킨/외부 스크립트가 쌓이면서 안 쓰는 JS/CSS 가 페이지 로딩을 무겁게 합니다. 하지만 **임대형 호스팅은 운영자가 손댈 수 있는 코드 영역이 제한적** 입니다. 그래서 이 프로젝트의 핵심은 단순 "미사용 코드 측정" 이 아니라:

> **운영자가 실제로 admin/스킨 편집기에서 정리 가능한 미사용 코드만 골라서 알려준다.**

cafe24 시스템 번들(`optimizer.php`, `/app/`)처럼 손댈 수 없는 코드는 리포트 맨 아래 한 줄 참고로만 밀어냅니다. 이 "제어 가능 vs 불가능" 구분이 프로젝트 전체를 관통하는 설계 철학입니다.

---

## 2. 전체 흐름 한눈에 보기

```
 [GitHub Actions cron / 수동 실행]
        │
        ▼
 ① Playwright 측정        tests/full-flow-coverage.spec.ts
   사이트 × 여정 조합으로 브라우저 자동 조작 → byte 단위 coverage 측정
        │  coverage-results/{siteId}__{journeyId}.json  (gitignored)
        ▼
 ② OpenAI 분석            analyze-js.js
   여정 union → 카테고리 분류 → cafe24 번들 디코딩 → GPT-4o 호출
        │  ai-analysis-results/{siteId}.txt  (gitignored)
        │  history/{YYYY-MM-DD}.json          (git 추적, 시계열 누적)
        ▼
 ③ history 자동 commit    .github/workflows/unused-js-check.yml
   오늘 snapshot 을 main 브랜치에 push (다음 실행의 7일 전 비교용)
        │
        ▼
 ④ 아티팩트 업로드         14일 보관 (coverage/ai/test-results/report)
        │
        ▼
 ⑤ Slack 전송            send-slack.js
   사이트별 section block 으로 한 메시지 발송
```

---

## 3. 파일별 지도 (여기부터 읽으세요)

| 파일 | 역할 | 언제 여기를 보나 |
|---|---|---|
| [sites.config.js](sites.config.js) | **사이트 정의** (baseUrl, selector, 검색 키워드) | 새 사이트 추가 / selector 가 깨졌을 때 |
| [tests/full-flow-coverage.spec.ts](tests/full-flow-coverage.spec.ts) | **1단계 측정.** 여정(journey) 정의 + 사이트×여정 동적 `test()` 생성 | 새 여정 추가 / 측정 로직 수정 / 사이트 조작 실패 디버깅 |
| [analyze-js.js](analyze-js.js) | **2단계 분석.** union · 카테고리 분류 · cafe24 번들 디코더 · 시계열 · GPT 프롬프트 | 분류 규칙·프롬프트·시계열 로직 수정 (프로젝트의 두뇌) |
| [send-slack.js](send-slack.js) | **3단계 전송.** 분석 텍스트를 Slack block 으로 발송 | Slack 메시지 포맷 수정 |
| [.github/workflows/unused-js-check.yml](.github/workflows/unused-js-check.yml) | CI 파이프라인 (cron, 단계 순서, history 자동 commit, 시크릿 주입) | 실행 순서·스케줄·시크릿 변경 |
| [playwright.config.ts](playwright.config.ts) | 데스크탑 UA / ko-KR / timeout / retry 설정 | 브라우저 환경·타임아웃 조정 |
| [history/](history/) | 매일 누적되는 시계열 snapshot (git 추적) | 시계열 데이터 확인 |
| [README.md](README.md) | 상세 스펙 / 사용법 | 명령어·환경변수 레퍼런스 |

> ⚠️ `js-coverage-result.json`, `test-output.json`, `play_log.txt` 는 초기 개발 중 남은 **레거시 산출물** 입니다. 파이프라인이 쓰지 않으니 무시하세요 (정리해도 무방).

---

## 4. 반드시 이해해야 할 핵심 개념 4가지

주니어가 이 4가지만 이해하면 코드 대부분이 읽힙니다.

### (1) 여정(Journey)과 URL 단위 합집합(union)

같은 사이트라도 **어떤 페이지를 방문하느냐**에 따라 실행되는 JS/CSS 가 다릅니다. 그래서 여러 "여정" 을 돌립니다.

| 여정 | 흐름 |
|---|---|
| `purchase` (PC) | 메인 → 카테고리 → 상품상세 → 장바구니 → 주문진입 |
| `search` | 메인 → 검색결과 → 상품상세 |
| `mobile` | 모바일 viewport(390×844) + 구매 흐름 재사용 |

**union 정책** ([analyze-js.js `unionJourneys`](analyze-js.js#L133)): 한 여정에서라도 사용된 코드는 used 로 간주합니다 (`unusedBytes = min(여정들)`, `usedBytes = max`). union 후에도 미사용 = "우리가 측정한 어떤 여정에서도 호출되지 않은 dead code 후보".
→ **여정을 늘릴수록 오탐(실제로는 쓰이는데 미사용으로 잡히는 것)이 줄어듭니다.** 이게 정확도 개선의 핵심 레버입니다.

### (2) 카테고리 분류 = "운영자가 손댈 수 있는가"

[analyze-js.js `categorize()`](analyze-js.js#L85) 가 모든 URL 을 host/path 로 분류합니다.

| 카테고리 | 예시 | 정리 위치 | 제어 가능? |
|---|---|---|---|
| `external_tracker` | channel.io, GTM, TikTok, Hackle | admin > 마케팅/외부 스크립트 | ✅ |
| `external_lib` | cdnjs, jsdelivr, jquery CDN | 스킨 HTML `<script src>` 제거 | ✅ |
| `external_font` | Google Fonts, Typekit | 스킨 HTML `<link>` 제거 | ✅ |
| `skin_uploaded` | `/web/upload/...js` | admin > 디자인 > 파일관리 | ✅ |
| `skin_user_added` | `optimizer_user.php` 번들 | admin > 스크립트/스타일 추가 | ✅ |
| `skin_inline_html` | `.html` URL 안 inline `<script>` | admin > 디자인 > HTML 편집 | ✅ |
| `skin_custom` | 스킨/보드/이벤트 자체 JS | 스킨 직접 편집 | ✅ |
| `cafe24_system` | `optimizer.php`, `/app/` | **직접 수정 불가** (admin 토글만) | ❌ |

`USER_CONTROLLABLE` 배열(✅ 항목)만 Slack 리포트의 메인이 되고, `cafe24_system` 은 마지막에 한 줄로만 노출됩니다.

### (3) cafe24 번들 디코딩

cafe24 는 여러 원본 파일을 `optimizer.php`(시스템) / `optimizer_user.php`(운영자 추가) 하나로 묶습니다. 파일 경로 목록이 URL 의 `filename` 파라미터에 **URL-safe base64 + raw DEFLATE + control byte 마커** 로 인코딩돼 있습니다.

[analyze-js.js `decodeCafe24Bundle()`](analyze-js.js#L25) 가 이걸 풀어 번들 안 개별 스킨 파일 경로(예: `design/skin13/js/cart.js`)를 복원합니다.

| 바이트 | 역할 |
|---|---|
| `\x15` (NAK) | record separator (파일 사이) |
| `\x0a` (LF) | path 안의 `-` |
| `\x0b` (VT) | prefix 변경 marker |
| `\x0c` (FF) | path/확장자 사이 marker |

> ⚠️ **정확도 한계 (반드시 인지):** 번들 응답에는 "이 byte 는 이 파일 것" 이라는 경계 정보가 **없습니다.** 그래서 번들 **전체**의 used/unused 만 측정되고, "이 개별 파일이 안 쓰임" 은 path 패턴 + 측정 여정 정보를 근거로 한 **GPT 추론** 입니다. 100% 보장이 아니며, 리포트에도 그 한계를 명시합니다.

### (4) 시계열 추적 (history/)

매일 cron 끝에 사이트별 요약 + 외부 트래커 목록을 `history/{날짜}.json` 으로 저장하고 main 에 자동 commit 합니다. 다음 실행 때 [7일 전 데이터와 비교](analyze-js.js#L234)해서 외부 트래커 미사용량이 **30KB 이상** 변한 항목을 Slack `⚠️ 변화` 섹션에 넣습니다.

- 상수: `HISTORY_DIFF_DAYS = 7`, `TRACKER_DIFF_MIN_KB = 30` ([analyze-js.js:16-17](analyze-js.js#L16))
- 첫 1주일은 비교 데이터가 없어 변화 섹션이 비어 있음 (정상)

---

## 5. 로컬에서 실행하기

```bash
npm install
npx playwright install --with-deps chromium

# 1단계: 측정 (coverage-results/ 생성)
npx playwright test tests/full-flow-coverage.spec.ts --project=chromium

# 2단계: 분석 (ai-analysis-results/ + history/ 생성) — OpenAI 키 필요
OPENAI_API_KEY=... node analyze-js.js

# 3단계: Slack 전송 — webhook 필요
SLACK_WEBHOOK_URL=... node send-slack.js
```

Windows PowerShell 이면 `$env:OPENAI_API_KEY="..."; node analyze-js.js` 형태로 실행하세요.

**팁:** OpenAI 키 없이 측정만 검증하려면 1단계만 돌리고 `coverage-results/*.json` 을 직접 열어 보면 됩니다. 분석 로직만 손볼 땐 기존 coverage 결과를 두고 2단계만 반복 실행하면 API 비용이 안 나갑니다(단, `analyze-js.js` 는 매 실행 GPT 를 호출하니 프롬프트만 확인할 땐 `openai.chat.completions.create` 직전에 `console.log(prompt)` 후 `return` 하는 식으로 임시 차단).

### 워크플로 수동 실행 (gh CLI)

```bash
gh workflow run unused-js-check.yml --ref main
gh run watch <run-id> --exit-status
gh run download <run-id> --name coverage-and-analysis
```

---

## 6. 자주 하게 될 작업 레시피

### 새 사이트 추가

[sites.config.js](sites.config.js) 에 객체 하나만 추가하면 끝입니다 (모든 여정에 자동 매핑됨).

```js
{
  id: 'new-shop',
  name: '예시샵',
  baseUrl: 'https://example.co.kr/',
  selectors: {
    productListUrl: 'https://example.co.kr/product/list.html?cate_no=N', // 권장: URL 직접 goto
    productLink: 'a[href*="/product/detail"]',
    cartButton: 'text="장바구니"',
    basketUrl: 'https://example.co.kr/order/basket.html',
    orderButton: 'text="전체상품주문", text="주문하기", a:has-text("주문하기")',
  },
  searchKeyword: '비타민', // 없으면 search 여정 자동 스킵
}
```

- `cate_no` 는 BEST/NEW 카테고리 URL 에서 확인. **반드시 `/product/list.html`** (그룹 페이지 `/product/cate_list.html` 아님 — detail 링크가 안 나옴).
- 추가 후 로컬에서 1단계만 돌려 해당 사이트의 coverage json 이 잘 생기는지 확인하세요.

### 새 여정 추가

[tests/full-flow-coverage.spec.ts](tests/full-flow-coverage.spec.ts) 의 `journeys` 배열에 함수 하나 추가:

```ts
{
  id: 'review',
  name: '리뷰 게시판 여정',
  isApplicable: (site) => true,   // 특정 사이트만 돌리려면 조건
  run: async (page, site) => {
    await page.goto(site.baseUrl + 'board/product/list.html');
    // ... 페이지 조작
  },
}
```

모든 사이트에 자동 매핑되어 `{siteId}__{journeyId}.json` 이 생성되고, `analyze-js.js` 의 union 에 자동 반영됩니다.

### 카테고리 분류 규칙 수정

새 외부 트래커/CDN 이 잡히면 [analyze-js.js](analyze-js.js#L65) 의 `TRACKER_HOSTS` / `LIB_CDN_HOSTS` / `FONT_HOSTS` Set 에 host 를 추가하세요. path 기반 규칙은 `categorize()` 함수 본문에서.

---

## 7. 안정성 관련 배경 지식 (왜 코드가 이렇게 생겼나)

cafe24 사이트의 특이 동작을 우회하려고 방어 코드가 많습니다. 지우기 전에 왜 있는지 알아두세요.

- **product detail 은 href 추출 후 `page.goto`** — 캐러셀 hidden anchor 를 click 하면 cafe24 가 page 를 닫아버림 ([spec.ts:126](tests/full-flow-coverage.spec.ts#L126))
- **`state: 'attached'`** — 캐러셀/슬라이더 안 hidden 요소도 찾기 위해
- **메인 페이지 fallback** — list 페이지에서 상품 못 찾으면 메인 BEST/NEW 에서 재시도
- **`page.on('dialog')` 자동 dismiss** — native alert 로 page hang 방지
- **`page.isClosed()` 가드** — page 가 닫힌 채로 stopCoverage 하면 throw → finally 에서 스킵 처리
- **데스크탑 Chrome UA 흉내** — 일부 사이트의 `HeadlessChrome` UA 차단 우회
- **사이트×여정 단위 test() 격리** — 한 조합 실패해도 나머지는 계속 진행
- **120s timeout + retry 2회** — 사이트 응답 지연 대비

---

## 8. 환경 변수 (GitHub Secrets)

| 이름 | 용도 | 폐기 시 증상 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI Chat Completions (`gpt-4o`) | 2단계 401/429 |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook | 5단계 401/404 → admin 에서 재발급 후 secret 갱신 |

GitHub 저장소 > Settings > Secrets and variables > Actions 에서 관리합니다.

---

## 9. 알려진 한계 (오해하면 안 되는 것)

1. **cafe24 번들 개별 파일 판정은 추론이다.** byte→파일 매핑 불가 (§4-(3)). 리포트의 개별 파일 목록은 "안 쓰일 가능성이 높은 후보" 이지 확정이 아닙니다.
2. **측정 안 한 페이지의 코드는 전부 미사용으로 보인다.** 현재 마이페이지·회원가입·로그인·게시판·이벤트·펀딩은 여정에 없습니다. 여기서만 쓰이는 코드는 dead code 로 오탐됩니다. → 여정 확대가 정확도 개선의 핵심.
3. **모바일 여정은 viewport 만 모바일.** UA 는 context 레벨이라 page 에서 못 바꿈. 완전한 모바일 UA 측정은 별도 Playwright project 가 필요.
4. **시계열 비교는 day 단위, 외부 트래커만.** 다른 카테고리 변화나 시간 단위 정밀도는 아직 없음.

---

## 10. 이어서 할 수 있는 작업 (개발 방향 제안)

주니어가 프로젝트를 디벨롭할 때 자연스러운 다음 스텝들입니다. 난이도와 함께 정리했습니다.

### 🟢 쉬움 — 몸풀기 좋은 작업
- **새 사이트 추가** (§6). 파이프라인 전체를 이해하기 좋은 첫 작업.
- **레거시 파일 정리** — `js-coverage-result.json`, `test-output.json`, `play_log.txt` 제거 (§3).
- **`TRACKER_HOSTS` 목록 보강** — 리포트에서 `unknown`/오분류로 뜨는 호스트를 올바른 카테고리로.

### 🟡 중간 — 정확도/리포트 개선
- **새 여정 추가** (마이페이지·로그인·게시판·이벤트 등) → dead code 오탐 감소 (§9-2). **가장 임팩트 큰 정확도 개선.**
- **완전한 모바일 UA 측정** — 별도 Playwright project(mobile UA context) 분리 (§9-3).
- **Slack 리포트 포맷 개선** — 현재 사이트별 3000자 제한으로 잘림(`send-slack.js`의 2900자 trim). 사이트별 개별 메시지/스레드, 또는 요약+상세 분리.
- **시계열 대상 확대** — 외부 트래커뿐 아니라 전체 카테고리 변화 추적 (`diffExternalTrackers` 일반화).
- **GPT 프롬프트 튜닝** — [analyze-js.js:334](analyze-js.js#L334) 의 프롬프트. 모델 교체(gpt-4o → 최신) 시 출력 안정성 검토.

### 🔴 큰 작업 — 구조 개선
- **번들 byte→파일 매핑 정확도 개선** — 현재 GPT 추론(§4-3). 예: 각 원본 파일을 개별 요청해 파일별 coverage 를 직접 측정하는 방식 연구.
- **시계열 대시보드** — `history/*.json` 을 읽어 추세 그래프를 보여주는 정적 웹페이지/리포트.
- **분석 결과 회귀 테스트** — coverage json → 분석 결과가 기대대로 나오는지 검증하는 테스트 (GPT 호출은 mock).

---

## 11. 막혔을 때

1. **측정이 실패한다** → GitHub Actions 실행 페이지의 `coverage-and-analysis` 아티팩트에서 `playwright-report/` 와 `test-results/` 를 받아 스크린샷/trace 확인. 사이트 selector 변경이 흔한 원인.
2. **특정 사이트만 상품을 못 찾는다** → `sites.config.js` 의 `productListUrl` 의 `cate_no` 가 유효한지, 실제 브라우저로 해당 URL 을 열어 detail 링크가 나오는지 확인.
3. **Slack 이 안 온다** → webhook 만료(401/404)가 흔함. admin 에서 재발급 후 secret 갱신.
4. **분석 결과가 이상하다** → `coverage-results/*.json` 을 직접 열어 raw 측정값부터 확인. 문제가 측정(1단계)인지 분석(2단계)인지 먼저 가르세요.
