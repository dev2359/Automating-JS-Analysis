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
      .filter(d => d.unusedBytes > 0)
      .sort((a, b) => b.unusedBytes - a.unusedBytes)
      .slice(0, 15) // 상위 15개 스크립트만
      .map(d => ({
        url: d.url.split('?')[0], // 쿼리스트링 제거하여 간소화
        totalBytes: d.totalBytes,
        unusedBytes: d.unusedBytes,
        unusedPercentage: d.unusedPercentage
      }));

    const prompt = `
다음은 웹사이트 자바스크립트 커버리지 중 "미사용 용량"이 가장 큰 상위 15개 파일 데이터입니다.

${JSON.stringify(filteredData, null, 2)}

위 데이터를 바탕으로 슬랙(Slack)에 바로 전송할 수 있는 리포트를 작성해주세요.
구성은 반드시 다음 양식을 지켜주세요:

*🚨 낭비가 가장 심한 JS 파일 Top 5*
(파일명이나 URL의 핵심 도메인만 짧게 적고, 몇 % / 몇 KB가 미사용 상태인지 확실하게 짚어서 나열해 주세요)

*🔍 종합 분석 및 최적화 제안*
(위 파일들의 정체(예: 쇼핑몰 기본 스크립트, 광고 트래커 등)를 유추하고, 어떻게 줄일 수 있는지 2~3줄로 명확하게 요약해 주세요)
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
