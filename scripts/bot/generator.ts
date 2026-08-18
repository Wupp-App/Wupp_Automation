import { genAI } from './config';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// 1. Yerel Ollama Çağrısı
async function generateWithOllama(systemPrompt: string, userPrompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

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
        options: {
          temperature: 0.85,
          top_p: 0.9,
        },
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

// 2. Groq Bulut API Çağrısı
async function generateWithGroq(model: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!GROQ_API_KEY) return null;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.85,
        top_p: 0.9,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  // Rastgele 2 ile 4 cümle arası hedef
  const targetSentences = Math.floor(Math.random() * 3) + 2;

  const systemInstruction = `
Sen Ekşi Sözlük yazarı olan gerçek, sokaktaki bir insansın. Kullanıcı adın: "${persona.username}".
Kişiliğin/Tavrın: ${persona.tone || persona.style || 'Gündelik, hafif kinayeli, net ve samimi'}.

KESİN KURALLAR:
1. ASLA felsefi, akademik, edebi, ansiklopedik veya edatlarla dolu cümleler kurma ("gösteren-gösterilen", "algı karmaşası", "kolektif hafıza", "altını çizmek", "bu başlık gösteriyor ki" gibi yapay zeka klişelerini yazarsan sistem çöker!).
2. Konuşma diliyle, sokak Türkçesiyle veya gerçek bir sözlük yazarı gibi doğrudan konuya gir.
3. Uzunluk: En az 2, en fazla 4 cümle olsun. Asla paragraf döktürme.
4. Tırnak işareti, başlık tekrarı veya açıklama metni ekleme. Sadece entry'yi yaz.

İYİ VE GERÇEKÇİ ÖRNEKLER:
- Başlık: "istanbul trafiği" -> "her gün ömrümden iki saat çalan illet. metrobüse binmektense evde oturup duvara bakmayı tercih ederim bazen."
- Başlık: "asgari ücret zammı" -> "markete gidip iki parça şey alana kadar çok iyi para gibi geliyordu. kasada yine gerçeğe tosladık."
- Başlık: "fenerbahçe" -> "yine bir şekilde umutlandırıp sezon sonu kahredecekler bizi, adım gibi eminim."
`;

  const contextPart =
    existingEntries.length > 0
      ? `\nÖnceki yazarların bahsettiği bazı noktalar:\n- ${existingEntries.slice(-2).join('\n- ')}`
      : '';

  const userPrompt = `Yorum yazacağın başlık: "${topicName}"${contextPart}

Lütfen yukarıdaki kurallara uyarak tam ${targetSentences} cümlelik doğal ve samimi bir sözlük entry'si yaz:`;

  // 1. Önce Ollama
  let text = await generateWithOllama(systemInstruction, userPrompt);

  // 2. Yedek Groq
  if (!text) {
    const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    for (const model of groqModels) {
      text = await generateWithGroq(model, systemInstruction, userPrompt);
      if (text) break;
    }
  }

  // 3. Yedek Gemini
  if (!text) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent(`${systemInstruction}\n\n${userPrompt}`);
      const response = await result.response;
      text = response.text()?.trim();
    } catch {}
  }

  if (!text) {
    console.error(`[AI Hatası] @${persona.username} için metin üretilemedi.`);
    return '';
  }

  // Temizleme: Baştaki/sondaki tırnakları ve gereksiz boşlukları at
  let cleanText = text
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^(entry:|yorum:)/i, '')
    .trim();

  // İlk harfi küçük yapma (Ekşi Sözlük stili doğallık için opsiyonel)
  if (cleanText.length > 0 && Math.random() > 0.3) {
    cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
  }

  console.log(`💬 [@${persona.username}]: "${cleanText}"`);
  return cleanText;
}
