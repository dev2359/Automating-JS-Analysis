/**
 * 여러 쇼핑몰의 구매 여정 커버리지 측정을 위한 사이트 정의.
 *
 * 새 사이트를 추가하려면 아래 배열에 객체 하나만 더 넣으면 된다.
 * 모든 사이트는 동일한 흐름(메인 → 카테고리 → 상품 상세 → 옵션 → 장바구니 → 주문 진입) 을
 * 공유하므로 selector 만 사이트별로 지정하면 된다.
 *
 * selector 타입
 *   - 문자열: page.locator(selector) 로 사용
 *   - { role, name, exact? }: page.getByRole(role, { name, exact }) 로 사용
 */
module.exports = [
  {
    id: 'themedion',
    name: '메디온',
    baseUrl: 'https://themedion.com/',
    selectors: {
      // 카테고리 이동 ("전제품" 같은 전체 카테고리 링크)
      category: { role: 'link', name: '전제품', exact: true },
      // 상품 목록에서 첫 번째 상품 상세 진입
      productLink: 'a[href*="/product/detail"]',
      // 장바구니 담기 버튼
      cartButton: 'text="장바구니"',
      // 장바구니 페이지 URL (담기 후 명시적 이동)
      basketUrl: 'https://themedion.com/order/basket.html',
      // 주문하기 버튼 (장바구니 페이지)
      orderButton: 'text="전체상품주문", text="주문하기", a:has-text("주문하기")',
    },
  },
  {
    id: 'celladix',
    name: '셀라딕스',
    baseUrl: 'https://celladix.co.kr/',
    selectors: {
      category: { role: 'link', name: 'ALL', exact: true },
      productLink: 'a[href*="/product/detail"]',
      cartButton: 'text="장바구니"',
      basketUrl: 'https://celladix.co.kr/order/basket.html',
      orderButton: 'text="전체상품주문", text="주문하기", a:has-text("주문하기")',
    },
  },
  {
    id: 'wellit',
    name: '웰릿',
    baseUrl: 'https://wellit.co.kr/',
    selectors: {
      category: { role: 'link', name: '모든 제품', exact: true },
      productLink: 'a[href*="/product/detail"]',
      cartButton: 'text="장바구니"',
      basketUrl: 'https://wellit.co.kr/order/basket.html',
      orderButton: 'text="전체상품주문", text="주문하기", a:has-text("주문하기")',
    },
  },
];
