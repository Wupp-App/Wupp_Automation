import { GoogleGenerativeAI } from '@google/generative-ai';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

async function generateWithGroq(model: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!GROQ_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.85,
        max_tokens: 150,
      }),
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

async function generateWithGemini(modelName: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
    const response = await result.response;
    return response.text()?.trim() || null;
  } catch {
    return null;
  }
}

async function generateWithOllama(systemPrompt: string, userPrompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: LOCAL_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: { temperature: 0.85, num_predict: 90 },
      }),
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const data = await response.json();
    return data?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

function getFallbackEntry(): string {
  const templates = [
    `valla bu konuda ne desek boş, her zamanki gibi yine olan bize oluyor.`,
    `haberi ilk gördüğümde şaşırmıştım ama sonra durup düşününce gayet normal geldi.`,
    `uzun uzun analiz kasmaya gerek yok bence, sonu baştan belli olan klasik bir mevzu.`,
    `herkes bir şeyler söylüyor da kimsenin işin aslına baktığı yok. yine boş bir gündemle oyalanıyoruz.`,
    `zamanında çok konuşulup tartışılmıştı ama hala aynı yerde sayıyoruz. değişen hiçbir şey yok.`,
    `yorumları okumaya geldim, tam da tahmin ettiğim gibi herkes birbirine girmiş.`
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  const sentenceTarget = Math.floor(Math.random() * 2) + 2;
  const systemInstruction = `
Sen Ekşi Sözlük'te yazan gerçek bir Türk internet kullanıcısısın. Kullanıcı adın: "${persona.username}".
Tavrın: ${persona.tone}.

KURALLAR:
1. Ansiklopedik, bülten veya akademik dil KESİNLİKLE YASAKTIR.
2. Tam ${sentenceTarget} cümle yaz.
3. Tırnak işareti ve başlık kullanma; gündelik sözlük jargonuyla yaz.
`;

  const contextPart = existingEntries.length > 0 
    ? `\nDiğer yazarların dedikleri:\n- ${existingEntries.slice(-2).join('\n- ')}`
    : '';
  const userPrompt = `Başlık: "${topicName}"${contextPart}\n\nSözlük entry'si yaz:`;

  let text: string | null = null;

  // 1. ÖNCELİK: Groq Modelleri
  const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];
  for (const model of groqModels) {
    text = await generateWithGroq(model, systemInstruction, userPrompt);
    if (text) {
      console.log(`⚡ [Groq: ${model}] @${persona.username} üretti.`);
      break;
    }
  }

  // 2. ÖNCELİK: Gemini Modelleri
  if (!text) {
    const geminiModels = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    for (const gModel of geminiModels) {
      text = await generateWithGemini(gModel, systemInstruction, userPrompt);
      if (text) {
        console.log(`✨ [Gemini: ${gModel}] @${persona.username} üretti.`);
        break;
      }
    }
  }

  // 3. ÖNCELİK: Ollama
  if (!text) {
    text = await generateWithOllama(systemInstruction, userPrompt);
    if (text) console.log(`🦙 [Ollama: ${LOCAL_MODEL}] @${persona.username} üretti.`);
  }

  // 4. Fallback (Tüm API kotaları dolsa dahi bot durmaz)
  if (!text) {
    console.warn(`🛡️ [Fallback] @${persona.username} için şablon entry kullanıldı.`);
    text = getFallbackEntry();
  }

  let cleanText = text
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^(entry:|yorum:)/i, '')
    .trim();

  if (cleanText.length > 0 && Math.random() > 0.3) {
    cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
  }

  return cleanText;
}
