const fs = require('fs');
const { OpenAI } = require('openai');

// GitHub Actions 실행 시 넘겨받을 혹은 로컬 .env 에 있는 API 키
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error('❌ OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

async function analyzeUnusedJS() {
  try {
    const rawData = fs.readFileSync('js-coverage-result.json', 'utf-8');
    const coverageData = JSON.parse(rawData);

    // AI에게 보낼 데이터가 너무 클 수 있으므로, 사용 안 된 비율이 높은 상위 파일들만 추려서 요약
    const filteredData = coverageData
      .filter((d: any) => d.unusedBytes > 0)
      .sort((a: any, b: any) => b.unusedBytes - a.unusedBytes)
      .slice(0, 15) // 상위 15개 스크립트만
      .map((d: any) => ({
        url: d.url.split('?')[0], // 쿼리스트링 제거하여 간소화
        totalBytes: d.totalBytes,
        unusedBytes: d.unusedBytes,
        unusedPercentage: d.unusedPercentage
      }));

    const prompt = `
다음은 웹사이트(E-commerce 쇼핑 플로우) E2E 테스트 과정에서 수집된 자바스크립트 커버리지 데이터 중 "사용되지 않은 바이트 수(unusedBytes)"가 가장 많은 상위 15개 파일 목록입니다.

${JSON.stringify(filteredData, null, 2)}

위 데이터를 바탕으로 다음 내용을 분석해 주세요:
1. 주요 미사용 원인 분석 (어떤 종류의 툴이나 라이브러리에서 주로 차지하는지, ex: 서드파티 마케팅 툴, 솔루션 기본 로딩 등)
2. 성능 최적화를 위한 3가지 구체적인 액션 아이템 제안
3. (Slack 알림용) 핵심 요약 2~3줄

최대한 간결하고 명확하게 한국어로 답변해 주세요.
`;

    console.log('🤖 OpenAI API에 분석을 요청하는 중...');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const aiMessage = response.choices[0].message.content;
    console.log('\n==================================');
    console.log('✨ [OpenAI 분석 결과] ✨\n');
    console.log(aiMessage);
    console.log('==================================\n');

    // 다음 단계(Slack 전송)를 위해 결과를 텍스트 혹은 JSON으로 임시 저장
    fs.writeFileSync('ai-analysis-result.txt', aiMessage || '');
    console.log('✅ 분석 결과가 ai-analysis-result.txt 에 저장되었습니다.');

  } catch (error) {
    console.error('API 호출 중 오류 발생:', error);
    process.exit(1);
  }
}

analyzeUnusedJS();
