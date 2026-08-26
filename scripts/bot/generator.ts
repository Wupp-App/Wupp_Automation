import { GoogleGenerativeAI } from '@google/generative-ai';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// Yarım kalan cümleleri tespit edip tam kapatılmış cümleyle sonlandıran yardımcı
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
        max_tokens: 450,
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
        options: { temperature: 0.95, num_predict: 200 },
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

function getFallbackEntry(sentenceCount: number, topicName: string): string {
  const cleanTopic = topicName.toLowerCase().replace(/^#/, '');

  const p1 = [
    `valla ${cleanTopic} konusunda ne desek boş, her zamanki gibi olan sıradan vatandaşa oluyor.`,
    `${cleanTopic} başlığını görünce yine şaşırmadım desem yeridir, şaşırma eşiğimizi çoktan kaybettik.`,
    `bu ${cleanTopic} meselesi hakkında herkes bir şeyler söylüyor ama kimsenin asıl meseleye odaklandığı yok.`,
    `zamanında ${cleanTopic} olayı çok tartışılmıştı ama hala aynı noktada sayıyoruz.`
  ];

  const p2 = [
    `altında yine bambaşka hesapların döndüğü apaçık ortada.`,
    `herkes uzman kesilmiş yine, oturup izlemekten başka yapacak bir şey yok.`,
    `sonucun nereye bağlanacağı baştan belli olan klasik bir gündem maddesi.`
  ];

  const p3 = [
    `bize yansıyan kısmıyla perde arkasında yaşananların uzaktan yakından alakası yok.`,
    `okudukça insanın sabrını ve mantığını sınayan cinsten bir gelişme.`,
    `uzun uzun analiz kasmaya gerek yok, iki gün sonra herkes unutup gidecek.`
  ];

  const p4 = [
    `neyse çekirdeğimizi aldık süreci izliyoruz.`,
    `bakalım bu durumun altından daha ne gibi sürprizler çıkacak.`,
    `özetle memleketin özeti niteliğinde bir olay.`
  ];

  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const pool = [pick(p1), pick(p2), pick(p3), pick(p4)];

  return pool.slice(0, Math.min(sentenceCount, pool.length)).join(' ');
}

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  // 2 ile 5 arasında rastgele cümle sayısı
  const sentenceTarget = Math.floor(Math.random() * (5 - 2 + 1)) + 2;

  const systemInstruction = `
Sen Ekşi Sözlük'te entry yazan gerçek bir Türk internet kullanıcısısın.
Kullanıcı adın: "${persona.username}".
Tavrın: ${persona.tone}.

YASAKLI KALIPLAR:
- "özetle", "sonuç olarak", "bu durum göstermektedir", "kayda değer", "altını çizmek gerekir", "bence bu olay".
- Resmi makale dili, haber bülteni jargonu veya akademik tez dili KESİNLİKLE YASAKTIR.
- Başlık tekrarı ve tırnak işareti ("") kullanma.

KURALLAR:
1. Bir sözlük yazarı gibi rahat, gündelik, samimi, alaycı ya da bezmiş bir üslupla yaz.
2. Metin KESİNLİKLE tam ${sentenceTarget} adet eksiksiz cümleden oluşmalıdır. Ne eksik ne fazla.
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

  // 3. Ollama Modeli
  if (!text) {
    text = await generateWithOllama(systemInstruction, userPrompt);
  }

  // 4. Dinamik Fallback (Dinamik 2-5 Cümle)
  if (!text) {
    text = getFallbackEntry(sentenceTarget, topicName);
  }

  // Temizleme ve noktalama düzeltmesi
  let cleanText = text
    .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
    .replace(/^(entry:|yorum:|cevap:)/i, '')
    .trim();

  cleanText = fixIncompleteSentence(cleanText);

  // Sözlük jargonu için %70 ihtimalle küçük harfle başlat
  if (cleanText.length > 0 && Math.random() > 0.3) {
    cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
  }

  return cleanText;
}
