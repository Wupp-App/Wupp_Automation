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
        max_tokens: 160,
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

function getFallbackEntry(sentenceCount: number): string {
  const shortTemplates = [
    `valla bu konuda ne desek boş, olan yine bize oluyor.`,
    `şaşırma eşiğimizi çoktan kaybettik maalesef.`,
    `klasik bir türkiye simülasyonu vakası daha.`
  ];
  const mediumTemplates = [
    `haberi ilk gördüğümde şaşırmıştım ama sonra durup düşününce gayet normal geldi. şaşırma eşiğimizi çoktan kaybettik.`,
    `uzun uzun analiz kasmaya gerek yok bence. sonu baştan belli olan klasik bir mevzu.`
  ];
  const longTemplates = [
    `zamanında çok konuşulup tartışılmıştı ama hala aynı yerde sayıyoruz. değişen hiçbir şey yok. herkes bir şeyler söylüyor da kimsenin işin aslına baktığı yok. yine boş bir gündemle oyalanıyoruz.`
  ];

  if (sentenceCount === 1) return shortTemplates[Math.floor(Math.random() * shortTemplates.length)];
  if (sentenceCount <= 2) return mediumTemplates[Math.floor(Math.random() * mediumTemplates.length)];
  return longTemplates[Math.floor(Math.random() * longTemplates.length)];
}

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  // 1 ile 4 arasında rastgele cümle hedefi belirlenir
  const sentenceTarget = Math.floor(Math.random() * 4) + 1;

  const systemInstruction = `
Sen Ekşi Sözlük'te yazan gerçek bir Türk internet kullanıcısısın. Kullanıcı adın: "${persona.username}".
Tavrın: ${persona.tone}.

KURALLAR:
1. Ansiklopedik, bülten veya akademik dil KESİNLİKLE YASAKTIR.
2. Metin uzunluğu KESİNLİKLE tam ${sentenceTarget} cümle olmalıdır. Ne eksik ne fazla.
3. Tırnak işareti, başlık ve "bence" gibi kalıplar kullanma; samimi sözlük diliyle yaz.
`;

  const contextPart = existingEntries.length > 0
    ? `\nDiğer yazarların dedikleri:\n- ${existingEntries.slice(-2).join('\n- ')}`
    : '';
  const userPrompt = `Başlık: "${topicName}"${contextPart}\n\nTam ${sentenceTarget} cümlelik sözlük entry'si yaz:`;

  let text: string | null = null;

  // 1. Groq
  const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];
  for (const model of groqModels) {
    text = await generateWithGroq(model, systemInstruction, userPrompt);
    if (text) {
      console.log(`⚡ [Groq: ${model}] @${persona.username} (${sentenceTarget} cümle) yazdı.`);
      break;
    }
  }

  // 2. Gemini
  if (!text) {
    const geminiModels = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    for (const gModel of geminiModels) {
      text = await generateWithGemini(gModel, systemInstruction, userPrompt);
      if (text) {
        console.log(`✨ [Gemini: ${gModel}] @${persona.username} (${sentenceTarget} cümle) yazdı.`);
        break;
      }
    }
  }

  // 3. Ollama
  if (!text) {
    text = await generateWithOllama(systemInstruction, userPrompt);
    if (text) console.log(`🦙 [Ollama: ${LOCAL_MODEL}] @${persona.username} (${sentenceTarget} cümle) yazdı.`);
  }

  // 4. Fallback
  if (!text) {
    console.warn(`🛡️ [Fallback] @${persona.username} için ${sentenceTarget} cümlelik şablon kullanıldı.`);
    text = getFallbackEntry(sentenceTarget);
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
