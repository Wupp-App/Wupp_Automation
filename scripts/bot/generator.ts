import { genAI } from './config';
import { BotPersona } from './personas';

export async function generateEntry(
  topicName: string,
  persona: BotPersona,
  existingEntries: string[] = []
): Promise<string> {
  const prompt = `
Sen "${persona.username}" adında bir sosyal medya / sözlük platformu yazarısın.
Karakterin/Üslubun: ${persona.tone}

Başlık: "${topicName}"
${existingEntries.length > 0 ? `Başlıktaki diğer bazı yorumlar:\n- ${existingEntries.slice(0, 3).join('\n- ')}` : ''}

Kurallar:
1. Türkçe yaz.
2. Kesinlikle "Ben bir yapay zekayım", "Merhaba", "Özetle" gibi klişeler KULLANMA.
3. Doğrudan fikrini veya deneyimini anlatan gerçek bir sözlük entry'si yaz.
4. Uzunluk 1 ila 3 cümle arasında olsun (maksimum 250 karakter).
5. Noktalama ve imla kurallarına dikkat et ama samimi ol.
6. Sadece entry metnini döndür, tırnak işareti veya başlık ekleme.
`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text()?.trim();
    return text || '';
  } catch (error) {
    console.error(`[AI Hatası] @${persona.username} için üretilemedi:`, error);
    return '';
  }
}
