#!/usr/bin/env node
// Stands in for `claude -p --output-format json --cloud` in tests.
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (!args.includes('--cloud') || !args.includes('-p')) {
    console.error('fake-claude: expected -p and --cloud, got ' + args.join(' '));
    process.exit(2);
  }
  if (input.includes('FAIL_PLEASE')) {
    console.error('Error: The cloud session failed to start.');
    process.exit(1);
  }
  const last = input.match(/<USER[^>]*>\n([\s\S]*?)\n<\/USER>\s*<\/CONVERSATION>/);
  const reply = `Echo: ${last ? last[1] : '?'}${input.includes('<PREFILL>') ? ' [prefilled]' : ''}\nUSER: leaked`;
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: 'session_fake' }));
});
