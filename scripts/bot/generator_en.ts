
import { GoogleGenerativeAI } from '@google/generative-ai';
import { BotPersona } from './personas';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ---------------------------------------------------------------------------
// DIVERSITY & MOOD POOLS (ENGLISH FORUM CULTURE)
// Picked randomly on each generation call to vary sentence rhythm and vibe.
// ---------------------------------------------------------------------------

const MOOD_POOL = [
  'extremely annoyed, blunt, cynical, short-tempered',
  'finding it hilarious, treating the whole thing as a meme',
  'dead serious, genuinely concerned about the long-term impact',
  'completely indifferent, shrug-emoji energy, "who even cares"',
  'nostalgic, comparing the current situation to older internet days',
  'utterly bewildered, baffled by how stupid or absurd this is',
  'philosophical and reflective, tying it back to human behavior',
  'energetic, laughing it off with sarcastic banter',
  'exhausted, tired of seeing this exact discourse repeated',
  'combative and critical, calling out corporate or user hypocrisy',
  'curious and inquisitive, trying to get to the bottom of the hype',
  'unbothered, calm, watching the chaos unfold with popcorn',
] as const;

const OPENING_STYLE_POOL = [
  'start directly with an admission/confession (e.g., "Honestly...", "Not gonna lie...")',
  'start with a short rhetorical question',
  'start with a personal anecdote or similar past experience',
  'start with a sarcastic observation or humorous metaphor',
  'start with a flat, matter-of-fact summary statement',
  'start with "Actually," or "In reality,"',
  'start with immediate disagreement/pushback against the consensus',
  'start with an exasperated internet sigh (e.g., "Man,", "Classic.", "Here we go again.")',
] as const;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Detects cut-off sentences/words and cleans them up.
// If no reliable punctuation mark is found within bounds, returns empty to invalidate.
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
      // Discard the trailing incomplete fragment and keep only complete sentences
      cleaned = cleaned.substring(0, lastPunctuation + 1).trim();
    } else {
      return '';
    }
  }
  return cleaned;
}

// Calculates word-based Jaccard similarity (0 to 1).
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

// Checks if the generated comment closely matches any previous comments on the topic.
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

// Dynamic fallback matrix based on the random mood
function getFallbackEntry(sentenceCount: number, topicName: string, mood: string): string {
  const cleanTopic = topicName.toLowerCase().replace(/^#/, '');
  const isFunnyMood = /hilarious|meme|indifferent|laughing|unbothered/.test(mood);
  const isSeriousMood = /serious|concerned|philosophical|combative|critical/.test(mood);

  const openersFunny = [
    `Honestly, this whole ${cleanTopic} thing is pure comedy at this point.`,
    `Saw ${cleanTopic} trending and almost spilled my coffee laughing.`,
    `Classic internet behavior when it comes to ${cleanTopic}.`,
  ];
  const openersSerious = [
    `I've been tracking ${cleanTopic} for quite a while now, and the trajectory is pretty alarming.`,
    `The sheer lack of accountability regarding ${cleanTopic} says everything about where we are heading.`,
    `People treat ${cleanTopic} like entertainment when it actually has tangible real-world consequences.`,
  ];
  const openersNeutral = [
    `Not even surprised to see ${cleanTopic} being argued about again.`,
    `Everyone suddenly has a doctorate in ${cleanTopic} whenever this discussion pops up.`,
  ];

  const middles = [
    `There's clearly an entirely different agenda being pushed behind closed doors.`,
    `Half of the people commenting haven't even read past the first headline.`,
    `It's a textbook case of overcomplicating an issue that already has an obvious cause.`,
    `The funny part is that nobody is asking the one question that actually matters.`,
    `People will defend their favorite side of this regardless of actual reality.`,
  ];

  const thirds = [
    `What actually happens backstage has zero resemblance to whatever narrative is trending.`,
    `It genuinely tests your sanity trying to follow the mental gymnastics around here.`,
    `No need to write a full thesis about it, everyone is going to forget this in two weeks anyway.`,
    `Can't tell if I should laugh or be frustrated by this whole circus.`,
  ];

  const closers = [
    `Either way, grabbed some popcorn and waiting for the dust to settle.`,
    `Let's see what ridiculous pivot happens next.`,
    `A quintessential snapshot of modern online discourse.`,
    `Just my two cents, do with it what you will.`,
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
  // Target sentences: 2 to 5 sentences
  const sentenceTarget = Math.floor(Math.random() * (5 - 2 + 1)) + 2;

  const MAX_ATTEMPTS = 3;
  let finalText: string | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const mood = pickRandom(MOOD_POOL);
    const openingStyle = pickRandom(OPENING_STYLE_POOL);
    const temperature = 0.85 + Math.random() * 0.35; // 0.85 - 1.20

    const systemInstruction = `
You are a genuine internet user posting on a fast-paced urban dictionary / discussion board (like Reddit, Hacker News, or Urban Dictionary).
Username: "${persona.username}".
General Personality: ${persona.tone || persona.style || 'Cynical, authentic, witty, casual'}.
Current Mood: ${mood}.

BANNED AI CLICHÉS (DO NOT USE):
- "In conclusion", "It is worth noting", "At the end of the day", "Underscores the need", "Beacon of hope", "This situation highlights".
- NO press release style, NO sterile essay tone, NO textbook academic lecturing.
- Do NOT repeat the topic title verbatim in quotes.
- Do NOT use Markdown formatting (no asterisks, bolding, italics, or headers).
- Do NOT copy exact phrasing or metaphors from previous entries; give a unique take.

RULES:
1. Sound like a real person casually typing from their phone or laptop. Match the specified mood accurately.
2. Open your comment like this: ${openingStyle}.
3. The comment MUST consist of EXACTLY ${sentenceTarget} complete sentences. Not more, not less.
4. Never leave a sentence half-finished; always end with appropriate punctuation (. ! ? ...).
5. Offer an authentic, distinct perspective compared to other commenters.
`;

    const contextPart =
      existingEntries.length > 0
        ? `\nWhat other users previously said (do NOT echo these phrases, find a distinct angle):\n- ${existingEntries.slice(-4).join('\n- ')}`
        : '';

    const userPrompt = `Topic: "${topicName}"${contextPart}\n\nWrite a genuine, authentic comment consisting of exactly ${sentenceTarget} sentences:`;

    let text: string | null = null;

    // 1. Groq Models
    const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];
    for (const model of groqModels) {
      text = await generateWithGroq(model, systemInstruction, userPrompt, temperature);
      if (text) break;
    }

    // 2. Gemini Models
    if (!text) {
      const geminiModels = ['gemini-2.5-flash', 'gemini-1.5-flash'];
      for (const gModel of geminiModels) {
        text = await generateWithGemini(gModel, systemInstruction, userPrompt, temperature);
        if (text) break;
      }
    }

    // 3. Ollama Model
    if (!text) {
      text = await generateWithOllama(systemInstruction, userPrompt, temperature);
    }

    // 4. Fallback Matrix
    if (!text) {
      text = getFallbackEntry(sentenceTarget, topicName, mood);
    }

    // Cleaning & punctuation normalization
    let cleanText = text
      .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
      .replace(/^(entry:|comment:|response:)/i, '')
      .replace(/\*\*/g, '')
      .trim();

    cleanText = fixIncompleteSentence(cleanText);

    // If cut off without salvageable sentences, invalidate and retry
    if (!cleanText || cleanText.length < 10) {
      finalText = null;
      continue;
    }

    // Internet slang touch: 70% chance of starting with lowercase
    if (cleanText.length > 0 && Math.random() > 0.3) {
      cleanText = cleanText.charAt(0).toLowerCase() + cleanText.slice(1);
    }

    // Jaccard similarity filter
    if (!isTooSimilar(cleanText, existingEntries)) {
      finalText = cleanText;
      break;
    }

    finalText = cleanText;
  }

  return finalText ?? getFallbackEntry(sentenceTarget, topicName, pickRandom(MOOD_POOL));
}
