const fs = require('fs');
const path = require('path');

const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
if (!slackWebhookUrl) {
  console.error('❌ SLACK_WEBHOOK_URL 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}

const RESULTS_DIR = path.resolve(__dirname, 'ai-analysis-results');

async function send() {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.error(`❌ ${RESULTS_DIR} 디렉토리가 없습니다.`);
    process.exit(1);
  }
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.txt'));
  if (files.length === 0) {
    console.error('❌ 발송할 분석 결과가 없습니다.');
    process.exit(1);
  }

  const sections = files.map(f => {
    const siteId = path.basename(f, '.txt');
    const text = fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8').trim();
    return { siteId, text };
  });

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🚨 ${sections.length}개 사이트 JS+CSS 커버리지 리포트 🚨`,
        emoji: true,
      },
    },
  ];

  sections.forEach((s, idx) => {
    if (idx > 0) blocks.push({ type: 'divider' });
    // Slack section text 길이 제한(3000자) 회피
    const trimmed = s.text.length > 2900 ? s.text.slice(0, 2900) + '\n…(중략)' : s.text;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: trimmed },
    });
  });

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: '이 리포트는 GitHub Actions 를 통해 자동 생성되었습니다.' },
    ],
  });

  console.log(`🚀 Slack 으로 ${sections.length}개 사이트 리포트를 전송합니다...`);
  const res = await fetch(slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack API 에러: ${res.status} ${res.statusText} ${body}`);
  }
  console.log('✅ Slack 알림 전송 완료');
}

send().catch(err => {
  console.error('Slack 전송 중 오류:', err);
  process.exit(1);
});
