import { GoogleGenerativeAI } from '@google/generative-ai';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// Yarım kalan cümleleri tespit edip temizleyen fonksiyon
function fixIncompleteSentence(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) return cleaned;

  const validEndings = ['.', '!', '?', '...'];
  const hasValidEnding = validEndings.some(ending => cleaned.endsWith(ending));

  if (!hasValidEnding) {
    const lastPunctuation = Math.max(
      cleaned.lastIndexOf('.'),
      cleaned.lastIndexOf('!'),
      cleaned.lastIndexOf('?'),
      cleaned.lastIndexOf('...')
    );

    if (lastPunctuation > 15) {
      cleaned = cleaned.substring(0, lastPunctuation + 1).trim();
    } else {
      cleaned = cleaned + '.';
    }
  }
  return cleaned;
}

async function generateWithGroq(model: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!GROQ_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

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
        temperature: 0.95,
        max_tokens: 450, // Kesintiyi önlemek için genişletildi
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
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { temperature: 0.95, maxOutputTokens: 450 }
    });
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
        options: { temperature: 0.95, num_predict: 180 },
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
  const shortPool = [
    `valla ne desek boş, olan yine bize oluyor.`,
    `şaşırma eşiğimizi kaybedeli çok oldu.`,
    `tam bir türkiye simülasyonu özeti.`,
    `klasik algı operasyonu, kimse yemez.`
  ];
  const mediumPool = [
    `haberi ilk gördüğümde şaşırmıştım ama sonra durup düşününce gayet normal geldi. şaşırma eşiğimizi çoktan kaybettik.`,
    `uzun uzun analiz kasmaya gerek yok. sonu baştan belli olan klasik bir mevzu.`
  ];
  const longPool = [
    `zamanında çok konuşulup tartışılmıştı ama hala aynı yerde sayıyoruz. değişen hiçbir şey yok. herkes bir şeyler anlatıyor da kimsenin işin aslına baktığı yok. yine boş bir gündemle oyalanıyoruz.`
  ];

  if (sentenceCount === 1) return shortPool[Math.floor(Math.random() * shortPool.length)];
  if (sentenceCount <= 2) return mediumPool[Math.floor(Math.random() * mediumPool.length)];
  return longPool[Math.floor(Math.random() * longPool.length)];
}

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  // 1 ile 4 arasında rastgele cümle hedefi
  const sentenceTarget = Math.floor(Math.random() * 4) + 1;

  const systemInstruction = `
Sen Ekşi Sözlük'te entry yazan gerçek bir Türk kullanıcısısın. Kullanıcı adın: "${persona.username}".
Tavrın: ${persona.tone}.

YASAKLAR (ROBOTİK VE YAPAY ZEKA KOKAN KALIPLAR):
- "özetle", "sonuç olarak", "bu durum göstermektedir", "kayda değer", "altını çizmek gerekir", "bence bu olay".
- Resmi makale dili, köşe yazısı jargonu veya ansiklopedik bülten dili KESİNLİKLE YASAKTIR.
- Başlık tekrarı ve tırnak işareti ("") kullanma.

KURALLAR:
1. Tam bir sözlük yazarı gibi rahat, gündelik, samimi, alaycı ya da bezmiş bir üslupla yaz.
2. Tam ${sentenceTarget} adet eksiksiz ve bitmiş cümle yaz.
3. Cümleyi asla yarım bırakma, sonuna mutlaka uygun noktalama işareti koy.
`;

  const contextPart = existingEntries.length > 0
    ? `\nÖnceki yazarların dedikleri:\n- ${existingEntries.slice(-2).join('\n- ')}`
    : '';

  const userPrompt = `Başlık: "${topicName}"${contextPart}\n\nBu başlığa tam ${sentenceTarget} cümlelik doğal sözlük entry'si yaz:`;

  let text: string | null = null;

  // 1. Groq Modelleri
  const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];
  for (const model of groqModels) {
    text = await generateWithGroq(model, systemInstruction, userPrompt);
    if (text) break;
  }

  // 2. Gemini Modelleri
  if (!text) {
    const geminiModels = ['gemini-2.5-flash', 'gemini-1.5-flash'];
    for (const gModel of geminiModels) {
      text = await generateWithGemini(gModel, systemInstruction, userPrompt);
      if (text) break;
    }
  }

  // 3. Ollama
  if (!text) {
    text = await generateWithOllama(systemInstruction, userPrompt);
  }

  // 4. Fallback
  if (!text) {
    text = getFallbackEntry(sentenceTarget);
  }

  // Temizleme ve yarım cümle onarma filtresi
  let cleanText = text
    .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
    .replace(/^(entry:|yorum:|cevap:)/i, '')
    .trim();

  cleanText = fixIncompleteSentence(cleanText);

  // Doğallık katmak için sözlük yazarları gibi %75 ihtimalle küçük harfle başlat
  if (cleanText.length > 0 && Math.random() > 0.25) {
    cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
  }

  return cleanText;
}
