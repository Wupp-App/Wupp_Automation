import { GoogleGenerativeAI } from '@google/generative-ai';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ---------------------------------------------------------------------------
// ÇEŞİTLİLİK HAVUZLARI
// Her çağrıda rastgele seçilerek prompt'a enjekte edilir; böylece aynı persona
// olsa bile metnin ruh hali ve yapısı seferden seferine gerçekten değişir.
// ---------------------------------------------------------------------------

const MOOD_POOL = [
  'bugün canı çok sıkkın, iğneleyici ve kısa fitilli',
  'olaya tamamen gırgırına almış, dalga geçer tavırda',
  'çok ciddi ve endişeli, olayı gerçekten dert edinmiş',
  'umursamaz ve alaycı, "bana ne" havasında',
  'nostaljik, konuyu eski günlerle kıyaslıyor',
  'şaşkınlıktan küçük dilini yutmuş, inanamıyor',
  'felsefi ve ağırbaşlı, olayı büyük resme bağlıyor',
  'enerjik ve heyecanlı, olayı komik bulup gülüyor',
  'yorgun ve bezmiş, "yine mi" tavrında',
  'kavgacı ve öfkeli, birilerini suçluyor',
  'meraklı ve soru sorar tavırda, işin aslını merak ediyor',
  'kayıtsız ve soğukkanlı, çok fazla önemsemiyor gibi davranıyor',
] as const;

const OPENING_STYLE_POOL = [
  'doğrudan bir itirafla başla (örn: "itiraf ediyorum...")',
  'kısa bir soruyla başla',
  'geçmişte yaşadığı benzer bir anıyla başla',
  'küfür etmeden ama sinirli bir ünlemle başla',
  'olayı bir başkasıyla kıyaslayarak başla',
  'espirili/ironik bir benzetmeyle başla',
  'düz, olayı özetleyen sıradan bir cümleyle başla',
  '"aslında" kelimesiyle başla',
  'bir itirazla, karşı görüş belirterek başla',
  'kısa bir "aynen" / "işte" gibi lafla başla',
] as const;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

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

// İki metin arasındaki kelime bazlı Jaccard benzerliğini hesaplar (0-1).
// 1'e yaklaştıkça metinler neredeyse aynı demektir.
function textSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\p{L}\s]/gu, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Üretilen metin, daha önce aynı başlığa yazılmış entry'lerin herhangi birine
// çok benziyor mu diye kontrol eder.
function isTooSimilar(candidate: string, existingEntries: string[], threshold = 0.55): boolean {
  return existingEntries.some((e) => textSimilarity(candidate, e) >= threshold);
}

async function generateWithGroq(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<string | null> {
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
        temperature,
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

async function generateWithGemini(
  modelName: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<string | null> {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { temperature, maxOutputTokens: 450 }
    });
    const result = await model.generateContent(`${systemPrompt}\n\n${userPrompt}`);
    const response = await result.response;
    return response.text()?.trim() || null;
  } catch {
    return null;
  }
}

async function generateWithOllama(
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<string | null> {
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
        options: { temperature, num_predict: 200 },
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

// Genişletilmiş fallback havuzu: API'ler tamamen düşerse bile daha fazla
// kombinasyon üretsin diye her parça grubu büyütüldü ve mood'a göre seçim yapılıyor.
function getFallbackEntry(sentenceCount: number, topicName: string, mood: string): string {
  const cleanTopic = topicName.toLowerCase().replace(/^#/, '');
  const isFunnyMood = /gırgır|alaycı|espri|umursamaz|kayıtsız/.test(mood);
  const isSeriousMood = /ciddi|endişeli|felsefi|öfkeli|kavgacı/.test(mood);

  const openersFunny = [
    `valla ${cleanTopic} konusu tam gündelik komedi malzemesi olmuş.`,
    `${cleanTopic} başlığını görünce içimden bir kahkaha koptu resmen.`,
    `bu ${cleanTopic} işi tam da beklediğim gibi saçmalığa dönmüş.`,
  ];
  const openersSerious = [
    `${cleanTopic} meselesini uzun zamandır dikkatle takip ediyorum, iç açıcı değil.`,
    `zamanında ${cleanTopic} olayı çok tartışılmıştı, bugün geldiğimiz nokta hiç iyi değil.`,
    `${cleanTopic} konusunda insanların bu kadar duyarsız kalması beni gerçekten üzüyor.`,
  ];
  const openersNeutral = [
    `${cleanTopic} başlığını görünce yine şaşırmadım desem yeridir.`,
    `bu ${cleanTopic} meselesi hakkında herkes bir şeyler söylüyor ama kimse asıl meseleye odaklanmıyor.`,
  ];

  const middles = [
    `altında yine bambaşka hesapların döndüğü apaçık ortada.`,
    `herkes uzman kesilmiş yine, oturup izlemekten başka yapacak bir şey yok.`,
    `sonucun nereye bağlanacağı baştan belli olan klasik bir gündem maddesi.`,
    `işin komik tarafı kimse asıl soruyu sormuyor.`,
    `bir de kalkmış bunu normalmiş gibi anlatanlar var.`,
  ];

  const thirds = [
    `bize yansıyan kısmıyla perde arkasında yaşananların uzaktan yakından alakası yok.`,
    `okudukça insanın sabrını ve mantığını sınayan cinsten bir gelişme.`,
    `uzun uzun analiz kasmaya gerek yok, iki gün sonra herkes unutup gidecek.`,
    `gülsem mi ağlasam mı karar veremedim açıkçası.`,
  ];

  const closers = [
    `neyse çekirdeğimizi aldık süreci izliyoruz.`,
    `bakalım bu durumun altından daha ne gibi sürprizler çıkacak.`,
    `özetle memleketin özeti niteliğinde bir olay.`,
    `ben yorumumu yaptım, gerisi sizin bileceğiniz iş.`,
  ];

  let openerPool = openersNeutral;
  if (isFunnyMood) openerPool = openersFunny;
  else if (isSeriousMood) openerPool = openersSerious;

  const pool = [pickRandom(openerPool), pickRandom(middles), pickRandom(thirds), pickRandom(closers)];
  return pool.slice(0, Math.min(sentenceCount, pool.length)).join(' ');
}

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  // 2 ile 5 arasında rastgele cümle sayısı
  const sentenceTarget = Math.floor(Math.random() * (5 - 2 + 1)) + 2;

  const MAX_ATTEMPTS = 3;
  let finalText: string | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Her denemede farklı mod / açılış tarzı / temperature seçiyoruz.
    // Bu, aynı persona ve aynı başlık için bile metni gerçekten farklılaştırır.
    const mood = pickRandom(MOOD_POOL);
    const openingStyle = pickRandom(OPENING_STYLE_POOL);
    const temperature = 0.85 + Math.random() * 0.35; // 0.85 - 1.20 arası

    const systemInstruction = `
Sen Ekşi Sözlük'te entry yazan gerçek bir Türk internet kullanıcısısın.
Kullanıcı adın: "${persona.username}".
Genel tavrın: ${persona.tone}.
Şu an ruh halin: ${mood}.

YASAKLI KALIPLAR:
- "özetle", "sonuç olarak", "bu durum göstermektedir", "kayda değer", "altını çizmek gerekir", "bence bu olay".
- Resmi makale dili, haber bülteni jargonu veya akademik tez dili KESİNLİKLE YASAKTIR.
- Başlık tekrarı ve tırnak işareti ("") kullanma.
- Daha önce yazılmış entry'lerdeki cümleleri veya kalıpları birebir tekrar etme; aynı fikri bile söyleyeceksen tamamen farklı kelimeler ve farklı bir açıdan söyle.

KURALLAR:
1. Bir sözlük yazarı gibi rahat ve gündelik yaz; ruh haline tam uygun bir üslup kullan (gerekiyorsa komik, gerekiyorsa sert ciddi, gerekiyorsa umursamaz ol).
2. Metni şu şekilde aç: ${openingStyle}.
3. Metin KESİNLİKLE tam ${sentenceTarget} adet eksiksiz cümleden oluşmalıdır. Ne eksik ne fazla.
4. Cümleyi asla yarım bırakma, sonuna mutlaka uygun noktalama işareti koy.
5. Diğer yazarlardan görsel/yapısal olarak ayrışan, kendine özgü bir bakış açısı kullan.
`;

    const contextPart = existingEntries.length > 0
      ? `\nÖnceki yazarların dedikleri (bunlarla AYNI cümleleri, AYNI benzetmeleri kullanma, farklı bir açı bul):\n- ${existingEntries.slice(-4).join('\n- ')}`
      : '';

    const userPrompt = `Başlık: "${topicName}"${contextPart}\n\nBu başlığa tam ${sentenceTarget} cümlelik, özgün bir sözlük entry'si yaz:`;

    let text: string | null = null;

    // 1. Groq Modelleri
    const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];
    for (const model of groqModels) {
      text = await generateWithGroq(model, systemInstruction, userPrompt, temperature);
      if (text) break;
    }

    // 2. Gemini Modelleri
    if (!text) {
      const geminiModels = ['gemini-2.5-flash', 'gemini-1.5-flash'];
      for (const gModel of geminiModels) {
        text = await generateWithGemini(gModel, systemInstruction, userPrompt, temperature);
        if (text) break;
      }
    }

    // 3. Ollama Modeli
    if (!text) {
      text = await generateWithOllama(systemInstruction, userPrompt, temperature);
    }

    // 4. Dinamik Fallback
    if (!text) {
      text = getFallbackEntry(sentenceTarget, topicName, mood);
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

    // Benzerlik kontrolü: çok benziyorsa farklı mood/temperature ile tekrar dene
    if (!isTooSimilar(cleanText, existingEntries)) {
      finalText = cleanText;
      break;
    }

    finalText = cleanText; // en azından son üretileni sakla, hepsi başarısız olursa bunu döneceğiz
  }

  return finalText ?? getFallbackEntry(sentenceTarget, topicName, pickRandom(MOOD_POOL));
}
