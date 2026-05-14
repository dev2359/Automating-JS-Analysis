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
      // PC 메뉴 클릭과 모바일 햄버거 안 hidden 메뉴를 모두 피하려고 list URL 직접 goto.
      // (themedion 의 '전제품' = cate_no=23)
      productListUrl: 'https://themedion.com/product/list.html?cate_no=23',
      // (참고) 메뉴 click 흐름 fallback 이 필요할 때를 위해 selector 유지
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
    searchKeyword: '에센스',
  },
  {
    id: 'celladix',
    name: '셀라딕스',
    baseUrl: 'https://celladix.co.kr/',
    selectors: {
      // BEST 카테고리. cate_list.html 그룹페이지가 아니라 list.html 로 직접 이동해
      // 상품 detail 링크가 확실히 노출되도록 함.
      productListUrl: 'https://celladix.co.kr/product/list.html?cate_no=51',
      productLink: 'a[href*="/product/detail"]',
      cartButton: 'text="장바구니"',
      basketUrl: 'https://celladix.co.kr/order/basket.html',
      orderButton: 'text="전체상품주문", text="주문하기", a:has-text("주문하기")',
    },
    // 셀라딕스 메인 추천 검색어 (page snapshot 기준)
    searchKeyword: '콜라겐',
  },
  {
    id: 'wellit',
    name: '웰릿',
    baseUrl: 'https://wellit.co.kr/',
    selectors: {
      productListUrl: 'https://wellit.co.kr/product/list.html?cate_no=25',
      productLink: 'a[href*="/product/detail"]',
      cartButton: 'text="장바구니"',
      basketUrl: 'https://wellit.co.kr/order/basket.html',
      orderButton: 'text="전체상품주문", text="주문하기", a:has-text("주문하기")',
    },
    // 웰릿 메인 추천 검색어 (page snapshot 기준)
    searchKeyword: '콜라겐',
  },
];
