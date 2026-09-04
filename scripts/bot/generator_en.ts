import { GoogleGenerativeAI } from '@google/generative-ai';
import { BotPersona } from './personas_en';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const MOOD_POOL = [
  'annoyed, sarcastic, and impatient with online discourse',
  'taking it lightly, treating the entire matter as a meme',
  'serious and concerned about the broader implications',
  'completely indifferent, shrug-emoji vibe, unbothered',
  'nostalgic, comparing this with how things used to be',
  'baffled and amazed by the sheer absurdity of it',
  'philosophical, connecting the incident to human nature',
  'energetic and amused, finding humor in the chaos',
  'exhausted and weary, projecting strong "not this again" energy',
  'combative, blunt, and calling people out',
  'curious and inquisitive, trying to understand what is actually going on',
  'calm and detached, observing the comments from the sidelines',
] as const;

const OPENING_STYLE_POOL = [
  'start directly with an admission (e.g., "honestly...", "not gonna lie...")',
  'start with a short rhetorical question',
  'start with a quick personal anecdote',
  'start with a sharp, dry remark',
  'start by comparing this situation to another familiar event',
  'start with a witty or ironic analogy',
  'start with a plain, blunt summary sentence',
  'start with "actually," or "in reality,"',
  'start by directly pushing back against popular opinion',
  'start with a short reaction (e.g., "classic.", "here we go again.")',
] as const;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fixIncompleteSentence(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) return cleaned;

  const validEndings = ['.', '!', '?', '...'];
  const hasValidEnding = validEndings.some((ending) => cleaned.endsWith(ending));

  if (!hasValidEnding) {
    const lastPunctuation = Math.max(
      cleaned.lastIndexOf('.'),
      cleaned.lastIndexOf('!'),
      cleaned.lastIndexOf('?')
    );

    if (lastPunctuation > 15) {
      cleaned = cleaned.substring(0, lastPunctuation + 1).trim();
    } else {
      return '';
    }
  }
  return cleaned;
}

function textSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
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
        max_tokens: 700,
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
      generationConfig: { temperature, maxOutputTokens: 700 },
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
        options: { temperature, num_predict: 400 },
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

function getFallbackEntry(sentenceCount: number, topicName: string, mood: string): string {
  const cleanTopic = topicName.toLowerCase().replace(/^#/, '');
  const isFunnyMood = /meme|hilarious|amused|indifferent|detached/.test(mood);
  const isSeriousMood = /serious|concerned|philosophical|combative/.test(mood);

  const openersFunny = [
    `honestly, this whole ${cleanTopic} thing is pure comedy at this point.`,
    `saw ${cleanTopic} trending and had to double check if this was actual satire.`,
    `the discussion around ${cleanTopic} has devolved into peak internet entertainment.`,
  ];
  const openersSerious = [
    `i have been tracking the ${cleanTopic} situation for a while, and it is genuinely concerning.`,
    `this is not the first time ${cleanTopic} came up, yet the core problem remains unaddressed.`,
    `people seem to be ignoring the real implications behind ${cleanTopic}.`,
  ];
  const openersNeutral = [
    `not surprised to see ${cleanTopic} making the rounds again.`,
    `everyone has a strong opinion on ${cleanTopic}, but very few are looking at the facts.`,
  ];

  const middles = [
    `there is clearly a whole layer of context being completely ignored here.`,
    `half the people arguing have not even bothered to check the background details.`,
    `it is just another cycle of overreacting to surface-level headlines.`,
    `the funniest part is how predictable the reactions were going to be.`,
    `it is always easier to assign blame than to actually understand the nuance.`,
  ];

  const thirds = [
    `what is being presented publicly rarely matches what is actually happening behind the scenes.`,
    `it genuinely tests your patience watching the same tired arguments get recycled.`,
    `no need for a lengthy breakdown because people will move on to the next topic by next week anyway.`,
    `hard to tell whether to laugh or just step away from the keyboard on this one.`,
  ];

  const closers = [
    `anyway, grab some popcorn and let them sort it out.`,
    `we will see what kind of mental gymnastics come out of this next.`,
    `pretty much a textbook summary of modern forum discourse.`,
    `just my two cents on the matter, take it or leave it.`,
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
  const sentenceTarget = Math.floor(Math.random() * (5 - 2 + 1)) + 2;

  const MAX_ATTEMPTS = 3;
  let finalText: string | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const mood = pickRandom(MOOD_POOL);
    const openingStyle = pickRandom(OPENING_STYLE_POOL);
    const temperature = 0.85 + Math.random() * 0.35;

    const systemInstruction = `
You are a real, authentic commenter on an urban internet discussion board / dictionary platform.
Username: "${persona.username}".
General Demeanor: ${persona.tone}.
Current Mood: ${mood}.

BANNED AI CLICHÉS:
- "in summary", "in conclusion", "it is worth noting", "this situation demonstrates", "a testament to", "underscores the importance", "in my opinion".
- Formal academic essay tone, press release jargon, or encyclopedic writing is STRICTLY FORBIDDEN.
- Never repeat the topic title verbatim inside quotes.
- Do NOT use markdown styling (no bolding, italics, asterisks, bullet points).
- Do NOT copy exact phrasings or metaphors from previous comments.

RULES:
1. Write like a real forum regular in casual, authentic internet English matching your current mood.
2. Open your comment following this style: ${openingStyle}.
3. The response MUST contain EXACTLY ${sentenceTarget} complete sentences. Not more, not less.
4. Never cut off mid-thought; end with appropriate punctuation.
5. Offer your own distinct, personal angle on the topic.
`;

    const contextPart =
      existingEntries.length > 0
        ? `\nPrevious user comments (do NOT reuse their phrases or identical takes, find a distinct angle):\n- ${existingEntries.slice(-4).join('\n- ')}`
        : '';

    const userPrompt = `Topic: "${topicName}"${contextPart}\n\nWrite an authentic forum entry of exactly ${sentenceTarget} sentences:`;

    let text: string | null = null;

    const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];
    for (const model of groqModels) {
      text = await generateWithGroq(model, systemInstruction, userPrompt, temperature);
      if (text) break;
    }

    if (!text) {
      const geminiModels = ['gemini-2.5-flash', 'gemini-1.5-flash'];
      for (const gModel of geminiModels) {
        text = await generateWithGemini(gModel, systemInstruction, userPrompt, temperature);
        if (text) break;
      }
    }

    if (!text) {
      text = await generateWithOllama(systemInstruction, userPrompt, temperature);
    }

    if (!text) {
      text = getFallbackEntry(sentenceTarget, topicName, mood);
    }

    let cleanText = text
      .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
      .replace(/^(entry:|comment:|response:)/i, '')
      .replace(/\*\*/g, '')
      .trim();

    cleanText = fixIncompleteSentence(cleanText);

    if (!cleanText || cleanText.length < 10) {
      finalText = null;
      continue;
    }

    if (cleanText.length > 0 && Math.random() > 0.3) {
      cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
    }

    if (!isTooSimilar(cleanText, existingEntries)) {
      finalText = cleanText;
      break;
    }

    finalText = cleanText;
  }

  return finalText ?? getFallbackEntry(sentenceTarget, topicName, pickRandom(MOOD_POOL));
}
