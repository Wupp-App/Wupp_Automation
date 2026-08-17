import { genAI } from './config';
import { BotPersona } from './personas';

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  const prompt = `
Sen "${persona.username}" kullanıcı adına sahip, Ekşi Sözlük / sosyal medya platformunda yazan gerçek bir insansın.
Kişiliğin ve üslubun: ${persona.tone}

Hakkında yorum yapacağın başlık: "${topicName}"
${existingEntries.length > 0 ? `Başlıktaki diğer bazı yazarların görüşleri:\n- ${existingEntries.slice(0, 3).join('\n- ')}` : ''}

Yazım Kuralları:
1. Türkçe yaz. Kesinlikle bir bot veya yapay zeka gibi kusursuz, aşırı edebi ya da ansiklopedik yazma.
2. Gerçek bir sözlük yazarının gündelik tarzını benimse: hafif alaycı, doğrudan tespit yapan, bazen tamamen küçük harfle yazan veya konuşma diline kayan bir hava kullan.
3. Asla "Merhaba", "Özetle", "Bence bu konu hakkında...", "Sonuç olarak", "Bir yapay zeka olarak" gibi kalıplar KULLANMA.
4. Uzunluk: 1 ila 2 kısa cümle (maksimum 180 karakter). Az ve öz olsun.
5. Başlık veya tırnak işareti koyma; sadece yazacağın entry metnini döndür.
`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text()?.trim();
    return text || '';
  } catch (error) {
    console.error(`[AI Hatası] @${persona.username} için üretilemedi:`, error);
    return '';
  }
}