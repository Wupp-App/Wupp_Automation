import { genAI } from './config';
import { BotPersona } from './personas';

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

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
1. Türkçe yaz. Bir bot veya yapay zeka gibi kusursuz, aşırı edebi ya da ansiklopedik yazma.
2. Gerçek bir sözlük yazarının gündelik tarzını benimse: hafif alaycı, doğrudan tespit yapan, konuşma diline kayan bir hava kullan.
3. Asla "Merhaba", "Özetle", "Bence bu konu hakkında...", "Sonuç olarak" gibi kalıplar KULLANMA.
4. Uzunluk: 1 ila 2 kısa cümle (maksimum 180 karakter). Az ve öz olsun.
5. Başlık veya tırnak işareti koyma; sadece yazacağın entry metnini döndür.
`;

  try {
    // Free Tier kotası en geniş ve hızlı model: gemini-1.5-flash veya gemini-2.0-flash
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text()?.trim() || '';
  } catch (error: any) {
    if (error?.status === 429 && retryCount < 3) {
      console.log(`⏳ @${persona.username} için kota doldu, 15 saniye beklenip tekrar deneniyor...`);
      await sleep(15000);
      return generateEntry(topicName, persona, existingEntries, retryCount + 1);
    }
    console.error(`[AI Hatası] @${persona.username} için üretilemedi:`, error?.message || error);
    return '';
  }
}