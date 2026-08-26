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
        temperature: 0.95, // Doğallık ve yaratıcılık için artırıldı
        max_tokens: 180,
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
      generationConfig: { temperature: 0.95 }
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
        options: { temperature: 0.95, num_predict: 90 },
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
    `valla ne desek boş, olan yine bize oluyor amk.`,
    `şaşırma eşiğimizi kaybedeli çok oldu ya.`,
    `tam bir türkiye simülasyonu özeti.`,
    `klasik algı operasyonu, yemezler.`,
    `gülüp geçilmesi gereken bomboş bir mevzu.`
  ];
  const mediumPool = [
    `haberi ilk gördüğümde şaşırmıştım ama sonra durup düşününce gayet normal geldi. şaşırma eşiğimizi çoktan kaybettik maalesef.`,
    `uzun uzun analiz kasmaya gerek yok bence. sonu baştan belli olan klasik bir saçmalık işte.`
  ];
  const longPool = [
    `zamanında çok konuşulup tartışılmıştı ama hala aynı yerde sayıyoruz. değişen hiçbir şey yok. herkes bir şeyler sıkıyor da kimsenin işin aslına baktığı yok. yine boş bir tantanayla oyalanıyoruz.`
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
  // 1 ile 4 arasında rastgele hedef cümle sayısı
  const sentenceTarget = Math.floor(Math.random() * 4) + 1;

  const systemInstruction = `
Sen Ekşi Sözlük'te entry yazan gerçek bir insansın. Kullanıcı adın: "${persona.username}".
Kişiliğin/Tavrın: ${persona.tone}.

KESİNLİKLE YASAKLI OLAN ŞEYLER (AI GİBİ DURAN HER ŞEY):
- "Özetle", "Sonuç olarak", "Bence bu durum", "Kayda değer", "Prestijli", "Strateji", "Gözler önüne sermektedir", "Altını çizmek gerekir".
- Resmi makale dili, köşe yazarı üslubu, haber spikeri veya Wikipedia anlatımı KESİNLİKLE YASAK.
- Tırnak işareti (""), başlık tekrarı, liste veya maddeleme işareti KULLANMA.

NASIL YAZACAKSIN (İNSAN GİBİ):
1. Tam bir sözlük yazarı gibi konuş; rahat, sokak ağzıyla, bazen alaycı, bazen bezmiş, bazen dobra.
2. Noktalamayı ve büyük harfleri aşırı kuralcı kullanma. Gerçek insanlar gibi yaz.
3. KESİNLİKLE tam ${sentenceTarget} cümle yaz. Ne 1 eksik ne 1 fazla.
`;

  const contextPart = existingEntries.length > 0
    ? `\nÖnceki yazarların dedikleri:\n- ${existingEntries.slice(-2).join('\n- ')}`
    : '';

  const userPrompt = `Başlık: "${topicName}"${contextPart}\n\nBu başlığa tam ${sentenceTarget} cümlelik doğal bir sözlük yorumu patlat:`;

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
    const geminiModels = ['gemini-2.5-flash', 'gemini-1.5-flash'];
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

  // Metin temizleme ve insanlaştırma filtreleri
  let cleanText = text
    .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
    .replace(/^(entry:|yorum:|cevap:)/i, '')
    .trim();

  // %75 ihtimalle ilk harfi küçük başlat (Sözlük jargonu gereği gerçek insan dokunuşu)
  if (cleanText.length > 0 && Math.random() > 0.25) {
    cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
  }

  return cleanText;
}
