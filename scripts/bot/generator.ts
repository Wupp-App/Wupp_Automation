import { genAI } from './config';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen3:latest';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// 1. Groq Bulut API
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
        model: model,
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

// 2. Gemini Bulut API (İzole - Hata durumunda zinciri kırmaz)
async function generateWithGemini(modelName: string, systemPrompt: string, userPrompt: string): Promise<string | null> {
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
    const response = await result.response;
    return response.text()?.trim() || null;
  } catch {
    return null;
  }
}

// 3. Yerel / Runner Ollama
async function generateWithOllama(systemPrompt: string, userPrompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000);

    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: LOCAL_MODEL,
        stream: false,
        keep_alive: '5m',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: {
          temperature: 0.85,
          num_predict: 90,
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

// 4. Kurtarıcı Şablon (Tüm AI API'leri çökse dahi botun boş geçmesini engeller)
function getFallbackEntry(topicName: string): string {
  const templates = [
    `valla bu konuda ne desek boş, her zamanki gibi yine olan bize oluyor.`,
    `haberi ilk gördüğümde şaşırmıştım ama sonra durup düşününce gayet normal geldi. şaşırma eşiğimizi çoktan kaybettik.`,
    `uzun uzun analiz kasmaya gerek yok bence, sonu baştan belli olan klasik bir mevzu.`,
    `herkes bir şeyler söylüyor da kimsenin işin aslına baktığı yok. yine boş bir gündemle oyalanıyoruz.`,
    `zamanında çok konuşulup tartışılmıştı ama hala aynı yerde sayıyoruz. değişen hiçbir şey yok.`
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
Tavrın: ${persona.tone || persona.style || 'Samimi, dobra, hafif alaycı, sokak ağzı'}.

YASAKLI KALIPLAR (YAZARSAN HATA VERİR):
- "kayda değer bir başarı", "göstergesidir", "kanıtlar", "sürdürülebilir strateji", "prestijli", "derinlemesine", "algı karmaşası", "statusuna geri dönmeyi", "kolektif hafıza".
- Ansiklopedik, resmi haber bülteni veya akademik tez dili KESİNLİKLE YASAKTIR.

KURALLAR:
1. Gerçek bir sözlük yazarının günlük konuşma diliyle yorum yap.
2. Tam ${sentenceTarget} cümle yaz.
3. Tırnak işareti, başlık ve "bence" gibi klişeler kullanma.
`;

  const contextPart =
    existingEntries.length > 0
      ? `\nDiğer yazarların dedikleri:\n- ${existingEntries.slice(-2).join('\n- ')}`
      : '';

  const userPrompt = `Başlık: "${topicName}"${contextPart}\n\nSözlük entry'si yaz:`;

  let text: string | null = null;

  // ── 1. ÖNCELİK: GROQ (Hızlı ve Güncel Modeller) ──
  const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'];
  for (const model of groqModels) {
    text = await generateWithGroq(model, systemInstruction, userPrompt);
    if (text) {
      console.log(`⚡ [Groq: ${model}] @${persona.username} yorum üretti.`);
      break;
    }
  }

  // ── 2. YEDEK: GEMINI (Farklı model sürümleri) ──
  if (!text) {
    const geminiModels = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    for (const gModel of geminiModels) {
      text = await generateWithGemini(gModel, systemInstruction, userPrompt);
      if (text) {
        console.log(`✨ [Gemini: ${gModel}] @${persona.username} yorum üretti.`);
        break;
      }
    }
  }

  // ── 3. YEDEK: OLLAMA ──
  if (!text) {
    text = await generateWithOllama(systemInstruction, userPrompt);
    if (text) {
      console.log(`🦙 [Ollama: ${LOCAL_MODEL}] @${persona.username} yorum üretti.`);
    }
  }

  // ── 4. KURTARICI KATMAN: DOĞAL SÖZLÜK ŞABLONU (ASLA BOŞ DÖNMEZ) ──
  if (!text) {
    console.warn(`🛡️ [Fallback Aktif] @${persona.username} için yedek doğal sözlük şablonu kullanıldı.`);
    text = getFallbackEntry(topicName);
  }

  let cleanText = text
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^(entry:|yorum:)/i, '')
    .trim();

  if (cleanText.length > 0 && Math.random() > 0.4) {
    cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
  }

  return cleanText;
}
