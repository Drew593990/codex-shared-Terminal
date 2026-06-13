const { loadConfig } = require('./config');
const { TranscriptStore } = require('./transcript-store');
const { ConversationStore } = require('./conversation-store');
const { SessionManager } = require('./session-manager');
const { AgentAdapter } = require('./agent-adapter');
const { createWebServer } = require('./web-server');

const config = loadConfig();
const transcriptStore = new TranscriptStore(config.transcriptDir);
const conversationStore = new ConversationStore(config.conversationDir);
const sessionManager = new SessionManager({ config, transcriptStore });
const agentAdapter = new AgentAdapter({ profiles: config.agentProfiles });
sessionManager.getOrCreate('main');

const { server } = createWebServer({ sessionManager, conversationStore, agentAdapter, config });

server.listen(config.port, config.host, () => {
  console.log(`ShareTerminal listening on http://${config.host}:${config.port}`);
  console.log('Default session: main');
});

function shutdown() {
  sessionManager.closeAll();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
