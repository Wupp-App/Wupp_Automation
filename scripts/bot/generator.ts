import { genAI } from './config';
import { BotPersona } from './personas';

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Sırayla denenecek güncel ve yedek modeller
const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.5-pro',
];

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = [],
  retryCount = 0
): Promise<string> {
  const prompt = `
Sen "${persona.username}" kullanıcı adına sahip, Ekşi Sözlük / sosyal medya platformunda yazan gerçek bir insansın.
Kişiliğin ve üslubun: ${persona.tone}

Hakkında yorum yapacağın başlık: "${topicName}"
${existingEntries.length > 0 ? `Başlıktaki diğer bazı yazarların görüşleri:\n- ${existingEntries.slice(0, 3).join('\n- ')}` : ''}

Yazım Kuralları:
1. Türkçe yaz. Kesinlikle robotik veya ansiklopedik yazma.
2. Gerçek bir sözlük yazarının gündelik tarzını benimse: hafif alaycı, doğrudan tespit yapan, konuşma diline kayan bir hava kullan.
3. Asla "Merhaba", "Özetle", "Bence bu konu hakkında...", "Sonuç olarak" gibi kalıplar KULLANMA.
4. Uzunluk: 1 ila 2 kısa cümle (maksimum 180 karakter).
5. Başlık veya tırnak işareti koyma; sadece yazacağın entry metnini döndür.
`;

  let lastError: any = null;

  for (const modelName of FALLBACK_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text()?.trim() || '';

      if (text) {
        return text.replace(/^["']|["']$/g, '');
      }
    } catch (error: any) {
      lastError = error;

      // Kota aşımı (429) durumunda bekle ve tekrar dene
      if ((error?.status === 429 || error?.message?.includes('429')) && retryCount < 2) {
        console.log(`⏳ @${persona.username} (${modelName}) için kota sınırı, 10 saniye bekleniyor...`);
        await sleep(10000);
        return generateEntry(topicName, persona, existingEntries, retryCount + 1);
      }

      console.warn(`[Model Uyarısı] ${modelName} başarısız oldu, sıradaki modele geçiliyor... (${error?.message || error})`);
    }
  }

  console.error(`[AI Hatası] @${persona.username} için hiçbir modelden metin üretilemedi:`, lastError?.message || lastError);
  return '';
}
