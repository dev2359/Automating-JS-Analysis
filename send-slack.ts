const fs = require('fs');

// Slack Webhook URL (GitHub Secrets 처리)
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

if (!slackWebhookUrl) {
  console.error('❌ SLACK_WEBHOOK_URL 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}

async function sendSlackNotification() {
  try {
    // OpenAI 결과물 읽기
    const analysisText = fs.readFileSync('ai-analysis-result.txt', 'utf-8');
    
    // Slack 블록 구성
    const slackPayload = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🚨 오늘의 E-commerce JS 커버리지 분석 보고서 🚨',
            emoji: true
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*OpenAI 분석 결과 요약:*\n\n${analysisText}`
          }
        },
        {
          type: 'divider'
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '이 리포트는 GitHub Actions를 통해 자동 생성되었습니다.'
            }
          ]
        }
      ]
    };

    console.log('🚀 Slack으로 메시지를 전송합니다...');
    
    // Node 18+ 내장 fetch 사용
    const res = await fetch(slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload)
    });

    if (!res.ok) {
      throw new Error(`Slack API 에러 발생: ${res.status} ${res.statusText}`);
    }

    console.log('✅ Slack 알림 전송이 완료되었습니다!');
  } catch (error) {
    console.error('Slack 전송 중 오류:', error);
    process.exit(1);
  }
}

sendSlackNotification();
