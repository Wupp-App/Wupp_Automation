import { genAI } from './config';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// 1. Yerel Ollama Çağrısı (GitHub Actions / Local)
async function generateWithOllama(systemPrompt: string, userPrompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 sn timeout

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
          temperature: 0.75,
        },
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Ollama Uyarısı] HTTP ${response.status}: ${errText.slice(0, 100)}`);
      return null;
    }

    const data = await response.json();
    const content = data?.message?.content?.trim();
    return content || null;
  } catch (err: any) {
    return null; // Local veya Runner Ollama kapalıysa sessizce Groq/Gemini'ye geçer
  }
}

// 2. Groq Bulut API Çağrısı (Native Fetch)
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
        temperature: 0.75,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.warn(`[Groq ${model} Hatası]: HTTP ${response.status} - ${errBody.slice(0, 120)}`);
      return null;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err: any) {
    console.warn(`[Groq Bağlantı Hatası (${model})]:`, err?.message || err);
    return null;
  }
}

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  // Rastgele 2 ile 5 cümle arası hedef
  const sentenceTarget = Math.floor(Math.random() * (5 - 2 + 1)) + 2;

  const variations = [
    'kendi tecrübene dayanarak veya doğrudan bir örnek vererek anlat',
    'durumu esprili veya hafif iğneleyici bir dille analiz et',
    'net, dobra ve doğrudan konunun özüne parmak basan bir bakış açısı sergile',
    'durumun arka planına veya toplumdaki yansımasına dikkat çek',
  ];
  const randomVariation = variations[Math.floor(Math.random() * variations.length)];

  const systemInstruction = `
Sen "${persona.username}" kullanıcı adına sahip, Ekşi Sözlük / sosyal medya platformunda yazan gerçek bir insansın.
Kişiliğin ve üslubun: ${persona.tone || persona.style || 'Samimi, gündelik ve doğal Türkçe'}

Yazım Kuralları:
1. Türkçe yaz. Kesinlikle robotik veya ansiklopedik yazma.
2. Gerçek bir sözlük yazarının gündelik tarzını benimse; ${randomVariation}.
3. Asla "Merhaba", "Özetle", "Bence bu konu hakkında...", "Sonuç olarak" gibi kalıplar KULLANMA.
4. Uzunluk: Tam olarak ${sentenceTarget} cümle kur.
5. Başlık veya tırnak işareti koyma; sadece yazacağın entry metnini döndür.
`;

  const contextPart =
    existingEntries.length > 0
      ? `\nBaşlıktaki diğer bazı yazarların görüşleri:\n- ${existingEntries.slice(-3).join('\n- ')}`
      : '';

  const userPrompt = `Hakkında yorum yapacağın başlık: "${topicName}"${contextPart}\n\nEntry:`;

  // ── 1. ÖNCELİK: OLLAMA (GitHub Actions Runner veya Local) ──
  const localText = await generateWithOllama(systemInstruction, userPrompt);
  if (localText) {
    console.log(`🦙 [Ollama: ${LOCAL_MODEL}] @${persona.username} yorum üretti.`);
    return localText.replace(/^["']|["']$/g, '');
  }

  // ── 2. YEDEK: BULUT GROQ API ──
  const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  for (const model of groqModels) {
    const groqText = await generateWithGroq(model, systemInstruction, userPrompt);
    if (groqText) {
      console.log(`⚡ [Groq Fallback: ${model}] @${persona.username} yorum üretti.`);
      return groqText.replace(/^["']|["']$/g, '');
    }
  }

  // ── 3. SON ÇARE: GEMINI MODELLERİ ──
  const geminiModels = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  for (const gModel of geminiModels) {
    try {
      const model = genAI.getGenerativeModel({ model: gModel });
      const result = await model.generateContent(`${systemInstruction}\n\n${userPrompt}`);
      const response = await result.response;
      const text = response.text()?.trim();
      if (text) {
        console.log(`✨ [Gemini: ${gModel}] @${persona.username} yorum üretti.`);
        return text.replace(/^["']|["']$/g, '');
      }
    } catch (geminiErr: any) {
      console.warn(`[Gemini ${gModel} Hatası]:`, geminiErr?.message || geminiErr);
    }
  }

  console.error(`[AI Hatası] @${persona.username} için hiçbir AI kaynağından metin üretilemedi.`);
  return '';
}
