const fs = require('fs');
const zlib = require('zlib');
const { OpenAI } = require('openai');

// GitHub Actions 실행 시 넘겨받을 혹은 로컬 .env 에 있는 API 키
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error('❌ OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

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
    // cafe24 인코딩은 컨트롤 바이트로 prefix-compress 한 path 스트림이며, 파일 사이의 점(.)도 제거되어 있다.
    // 컨트롤 바이트 제거 → 각 path가 'js' 로 끝나고 다음 path가 '/home' 으로 시작하므로 그 경계로 split.
    const flat = decoded.replace(/[\x0a\x0b\x0c\x15]/g, '');
    const files = flat.split(/js(?=\/home)/g).map((s, i, arr) => {
      if (i < arr.length - 1) return s + '.js';
      // 마지막 항목: 실제 '.js' 가 살아있거나, 'js' 로만 끝나면 '.js' 로 보정
      if (s.endsWith('.js')) return s;
      if (s.endsWith('js')) return s.slice(0, -2) + '.js';
      return s;
    }).filter(s => s.length > 0);
    return files;
  } catch (e) {
    return null;
  }
}

// URL에서 GPT가 인식하기 좋은 짧은 이름 추출 (host + 마지막 path 세그먼트)
function shortName(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
    return `${u.host}/${seg}`;
  } catch {
    return url;
  }
}

async function analyzeUnusedJS() {
  try {
    const rawData = fs.readFileSync('js-coverage-result.json', 'utf-8');
    const coverageData = JSON.parse(rawData);

    // AI에게 보낼 데이터가 너무 클 수 있으므로, 사용 안 된 비율이 높은 상위 파일들만 추려서 요약
    const filteredData = coverageData
      .filter(d => d.unusedBytes > 0)
      .sort((a, b) => b.unusedBytes - a.unusedBytes)
      .slice(0, 15)
      .map(d => {
        const bundled = d.url.includes('optimizer.php') ? decodeCafe24Bundle(d.url) : null;
        return {
          name: shortName(d.url),
          fullUrl: d.url,
          totalKB: +(d.totalBytes / 1024).toFixed(1),
          unusedKB: +(d.unusedBytes / 1024).toFixed(1),
          unusedPercentage: d.unusedPercentage,
          // cafe24 optimizer 번들이면 실제로 묶여있는 원본 JS 파일들
          ...(bundled && bundled.length ? {
            bundledFileCount: bundled.length,
            bundledFiles: bundled.slice(0, 50)
          } : {})
        };
      });

    const prompt = `
다음은 웹사이트 자바스크립트 커버리지 중 "미사용 용량"이 가장 큰 상위 15개 파일 데이터입니다.
용량 단위는 KB(킬로바이트)입니다.

${JSON.stringify(filteredData, null, 2)}

위 데이터를 바탕으로 슬랙(Slack)에 바로 전송할 수 있는 리포트를 작성해주세요.
다음 규칙을 반드시 지켜주세요:
- 파일을 도메인으로 뭉뚱그리지 말고, name 필드에 있는 "host/파일명" 형태를 그대로 사용해 어떤 파일인지 식별 가능하게 표기할 것.
- 용량은 unusedKB / totalKB 값을 그대로 KB 단위로 표기할 것. (예: "1299.7 KB / 1693.0 KB 미사용")
- bundledFiles 필드가 있는 항목은 cafe24 solution의 optimizer.php가 여러 원본 JS 파일을 하나로 묶어 서빙하는 케이스이므로, 묶여있는 대표 파일명 5~10개를 함께 짧게 나열해 어떤 기능 모듈들이 들어있는지 보여줄 것 (전체 경로 대신 파일 basename만, 예: "Front/basket.js, Front/BasketApp.js, async/asyncOrder.js ...").

리포트 구성:

*🚨 낭비가 가장 심한 JS 파일 Top 5*
(각 항목: name + 미사용 % + 미사용 KB / 전체 KB. bundledFiles가 있으면 그 아래에 "└ 묶인 파일: a.js, b.js, c.js ... (총 N개)" 형식으로 한 줄 추가)

*🔍 종합 분석 및 최적화 제안*
(위 파일들의 정체(예: 쇼핑몰 기본 스크립트, 광고 트래커, 채팅 SDK 등)를 유추하고, 어떻게 줄일 수 있는지 3~4줄로 구체적으로 요약해 주세요. cafe24 번들의 경우 묶인 모듈 중 실제 사용 안 되는 영역이 무엇일지도 짚어주세요.)
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

    fs.writeFileSync('ai-analysis-result.txt', aiMessage || '');
    console.log('✅ 분석 결과가 ai-analysis-result.txt 에 저장되었습니다.');

  } catch (error) {
    console.error('API 호출 중 오류 발생:', error);
    process.exit(1);
  }
}

analyzeUnusedJS();
