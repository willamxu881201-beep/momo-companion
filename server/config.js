// All settings come from environment variables (on the server: /etc/momo/momo.env).

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(env.PORT, 8080),
  host: env.HOST || '127.0.0.1',
  dataDir: env.DATA_DIR || './data',
  timeZone: env.MOMO_TZ || 'Asia/Kuala_Lumpur',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  parentPassword: env.PARENT_PASSWORD || '',

  arkApiKey: env.ARK_API_KEY || '',
  routerModel: env.ROUTER_MODEL || 'doubao-seed-2-1-lite-260915',
  personaModel: env.PERSONA_MODEL || 'doubao-seed-character-260628',
  asrModel: env.ASR_MODEL || 'doubao-seed-2-0-mini-260428',

  ttsAppId: env.DOUBAO_APPID || '',
  ttsToken: env.DOUBAO_TOKEN || '',

  limits: {
    chatPerDay: num(env.CHAT_PER_DAY, 80),
    asrPerDay: num(env.ASR_PER_DAY, 150),
    ttsCharsPerDay: num(env.TTS_CHARS_PER_DAY, 20000),
  },
};
