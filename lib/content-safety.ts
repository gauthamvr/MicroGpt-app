// lib/content-safety.ts
//
// Prompt-side content rules for AI generation. Google Play's
// AI-Generated Content policy requires apps to *prevent* sexual and
// other restricted output, so this is the first of three layers:
//
//   1. Prompt filter (this file) — rejects image prompts and chat
//      messages that ask for sexual, violent or hateful content before
//      any model runs. Cheap, and it's what a reviewer hits first.
//   2. Safety negative prompt — steers SD away from nudity even when
//      the prompt itself is innocent.
//   3. On-device NSFW image classifier (native, NsfwFilter.kt) — scores
//      every generated image and withholds anything flagged. This is
//      the real backstop; keyword lists are always bypassable.
//
// Matching runs on a normalized copy of the text: accents stripped,
// common leetspeak undone, spaced-out letters ("n u d e") rejoined and
// long letter runs ("nuuude") collapsed. Terms are matched on whole
// words so "class" never trips "ass" and "therapist" never trips "rapist".

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

function normalize(text: string): string {
  let t = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  // Undo leetspeak only inside words ("s3x", "p0rn"), so "4k" or "1girl"
  // style tags don't turn into new words.
  t = t.replace(/[a-z][a-z0-9@$]*[0-9@$][a-z0-9@$]*/g, (w) =>
    w.replace(/[0134578@$]/g, (c) => LEET[c] ?? c),
  );
  // Rejoin letters spaced out to dodge filters: "n u d e", "s.e.x".
  t = t.replace(/\b(?:[a-z][\s._*\-]+){2,}[a-z]\b/g, (m) => m.replace(/[^a-z]/g, ''));
  // "nuuude" → "nude"
  t = t.replace(/([a-z])\1{2,}/g, '$1');
  // Everything that isn't a letter/digit becomes a single space so
  // terms can be matched on word boundaries without lookbehind.
  t = t.replace(/[^a-z0-9Ѐ-ӿ]+/g, ' ').trim();
  return ` ${t} `;
}

function wordRegex(terms: string[]): RegExp {
  return new RegExp(`\\s(?:${terms.join('|')})(?=\\s)`);
}

// Sexual content. Each entry is a regex source matched as whole words.
const SEXUAL_TERMS = [
  'nud(?:e|es|ity|ist|ists|ism)',
  'naked(?:ness)?',
  'nsfw',
  'nsfl',
  'topless',
  'bottomless',
  'undress(?:ed|es|ing)?',
  'unclothed',
  'unclad',
  'disrob(?:e|ed|ing)',
  '(?:no|without|without any|with no|sans|removing|remove|removed|take off|taking off|took off) (?:clothes|clothing|top|shirt|pants|underwear|bra|panties|dress)',
  'clothes off',
  'cloth(?:es|ing) (?:free|optional)',
  // Euphemisms for nudity (October 2026 red-team: all of these reached
  // the model, and some of the images got past the classifier).
  'birthday suit',
  'in the buff',
  'in the altogether',
  'au natur[ae]l',
  '(?:without|not) a stitch',
  'as nature intended',
  'skyclad',
  '(?:wearing|wears|wore|dressed in|clad in) nothing',
  'not wearing (?:anything|a thing|any clothes|any clothing)',
  'nothing (?:underneath|beneath)',
  '(?:wearing|wears|wore|dressed in|clad in|draped in|wrapped in|covered in|covered by|covered with) (?:only|just|nothing but)',
  '(?:covered only|only covered) (?:by|in|with)',
  'nothing but (?:a |an |her |his |their )?(?:apron|towel|sheet|bedsheet|blanket|smile|skin|socks|heels|necklace|jewelry|jewellery|ribbons?|tattoos)',
  'bar(?:e|es|ed|ing) (?:it )?all',
  'lady godiva',
  'adam and eve',
  'eve in (?:the )?(?:garden of )?eden',
  'body ?paint(?:ed|ing)?',
  'semi ?nud\\w*',
  'semi ?naked',
  'half ?dressed',
  'partially (?:clothed|dressed)',
  'scantily',
  'skimpy',
  'barely (?:clothed|dressed|covered)',
  'private parts',
  '(?:her|his|their) privates',
  '(?:side|under) ?boobs?',
  'negligee?s?',
  'nighties?',
  'sheer (?:dress|top|shirt|blouse|fabric|gown|nightgown|robe|bodysuit)',
  'strip(?:ped|ping|per|pers|tease)',
  'nipples?',
  'areolae?',
  'areolas',
  'genital(?:s|ia)?',
  'penis(?:es)?',
  'vagina(?:s|l)?',
  'vulva',
  'labia',
  'clitoris',
  'pubic',
  'crotch',
  'pussy',
  'cocks?',
  'dicks?',
  'boob(?:s|ies)?',
  'tits',
  'titties',
  'breasts',
  'bare (?:chest|chested|breast|breasts|skin|body|butt|bottom|ass)',
  'buttocks',
  'butts?',
  'ass(?:es)?',
  'anus',
  'anal',
  'sex',
  'sexy',
  'sexual(?:ly|ized|ised)?',
  'porn(?:o|ographic|ography|star)?',
  'hentai',
  'ecchi',
  'erotic(?:a|ism)?',
  'lewd',
  'xxx',
  'fetish(?:es)?',
  'bdsm',
  'bondage',
  'lingerie',
  'underwear',
  'panties',
  'panty',
  'thongs?',
  'g string',
  'bras?',
  'bikinis?',
  'seductive(?:ly)?',
  'seduc(?:e|es|ing|tion)',
  'sensual',
  'provocative(?:ly)?',
  'suggestive',
  'orgasm(?:s|ic)?',
  'masturbat\\w*',
  'intercourse',
  'cum(?! laude)',
  'cumshot',
  'semen',
  'sperm',
  'ejaculat\\w*',
  'cleavage',
  'upskirt',
  'downblouse',
  'see ?through',
  'transparent (?:clothes|clothing|dress|shirt|top|bra|lingerie)',
  'wet (?:t ?shirt|shirt|clothes)',
  'playboy',
  'onlyfans',
  'camgirls?',
  'escorts?',
  'hookers?',
  'prostitut\\w*',
  'naturists?',
  'skinny ?dipping',
  'boudoir',
  'pin ?up',
  'spread(?:ing)? (?:her |his |their )?legs',
  'horny',
  'aroused',
  'arousal',
  'milf',
  'busty',
  'voluptuous',
  'thicc',
  '(?:big|huge|large|giant) (?:boobs|breasts|tits|ass|butt)',
  'camel ?toe',
  'nip ?slip',
  'wardrobe malfunction',
  'explicit',
  'uncensored',
  'rule ?34',
  'r34',
  'futanari',
  'futa',
  'ahegao',
  'kinky',
  'dominatrix',
  'incest',
  'rap(?:e|ed|es|ing)',
  'molest\\w*',
  'grop(?:e|ed|ing)',
  'loli(?:con)?',
  'shota(?:con)?',
  'jailbait',
  'underage',
  'pedo\\w*',
  'paedo\\w*',
  // Non-English
  'desnud[oa]s?',
  'nackt\\w*',
  'nues?',
  'nud[oa]s?',
  'sin ropa',
  'en cueros',
  'en pelotas',
  'sans (?:vetements?|habits)',
  'a poil',
  'tout(?:e)? nue?',
  'deshabill\\w*',
  'naakt\\w*',
  'bloot',
  'blote',
  'ohne (?:kleidung|kleider|klamotten)',
  'oben ohne',
  'unbekleidet\\w*',
  'splitter(?:faser)?nackt\\w*',
  'senza (?:vestiti|abiti|veli)',
  'svestit[aoie]',
  'spogliat[aoie]',
  'nuas?',
  'sem roupas?',
  'despid(?:a|as)',
  // Portuguese "pelada" is also a kickabout and Spanish "pelado" means
  // peeled; Polish "naga" is also a serpent deity and a chili. Both only
  // count next to a word for a person.
  '(?:mulher|mulheres|garota|garotas|menina|meninas|moca|mocas|homem|homens) pelad[oa]s?',
  '(?:kobieta|kobiety|dziewczyna|dziewczyny|mezczyzna|chlopak) nag[aiey]',
  'nag[aiey] (?:kobieta|kobiety|dziewczyna|dziewczyny|mezczyzna|chlopak)',
  'rozebran[aey]',
  'bez ubran(?:ia)?',
  'sexe',
  'seks',
  'голая',
  'голый',
  'голые',
  'обнаженн\\w*',
  'секс',
  'порно',
];

const SEXUAL_CJK = ['裸', 'ヌード', 'エロ', '色情', 'セックス', '性交', '成人向け', '야한', '누드', '섹스'];

// Graphic violence and hate imagery — also Restricted Content.
const VIOLENT_HATE_TERMS = [
  'gore',
  'gory',
  'decapitat\\w*',
  'behead\\w*',
  'dismember\\w*',
  'mutilat\\w*',
  'disembowel\\w*',
  'eviscerat\\w*',
  'severed (?:head|heads|limb|limbs|arm|arms|leg|legs)',
  'dead bod(?:y|ies)',
  'corpses?',
  'blood ?bath',
  'suicide',
  'self ?harm',
  'swastikas?',
  'nazis?',
  'kkk',
  'white power',
  'nigg\\w*',
  'faggots?',
  'fags?',
  'retard(?:ed|s)?',
  'tranny',
  'kikes?',
  'chinks?',
  'spics?',
];

// SDXL renders legible text, so "a sign that says …" can put profanity in
// an image. Whole words only: "Pissarro" and "shiitake" stay allowed.
const PROFANITY_TERMS = [
  'fuck\\w*',
  'fck\\w*',
  'fuk\\w*',
  'motherf\\w*',
  'shit\\w*',
  'bullshit',
  'bitch\\w*',
  'cunts?',
  'assholes?',
  'dickheads?',
  'wank\\w*',
  'twats?',
  'slut\\w*',
  'whores?',
  'bollocks',
  'bastards?',
  'piss(?:ed|ing)?',
];

// Terms that identify a minor. Combined with *any* body/intimacy word
// the prompt is refused, even if the intimacy word is innocent on its
// own ("bath", "bed", "pose").
const MINOR_TERMS = [
  'child(?:ren)?',
  'kids?',
  'toddlers?',
  'bab(?:y|ies)',
  'infants?',
  'minors?',
  'teen(?:s|age|ager|agers)?',
  'preteens?',
  'tweens?',
  'schoolgirls?',
  'schoolboys?',
  'school uniform',
  '(?:young|little|small) (?:girl|girls|boy|boys)',
  'girls? (?:aged? )?(?:[1-9]|1[0-7])',
  '(?:[1-9]|1[0-7]) ?(?:yo|y o|years? old|year olds?)',
];

// Settings where SD models routinely undress people even when the prompt
// never asks for it (calibration: bath, onsen and sunbathing prompts
// produced most of the near-misses). Refused when a person is in the
// prompt; "a hot spring in the mountains" alone is fine.
const PERSON_TERMS = [
  'wom[ae]n',
  'girls?',
  'lad(?:y|ies)',
  'females?',
  'm[ae]n',
  'guys?',
  'boys?',
  'waifus?',
  '[1-9] ?girls?',
  '[1-9] ?boys?',
  'models?',
  'couples?',
  'persons?',
  'people',
  'wife',
  'girlfriend',
  'husband',
  'boyfriend',
  'princess',
  'goddess',
];

// A pronoun stands for a person in an image prompt ("she is in the
// shower"). Not used for character cards: nearly every card says "she" or
// "he" somewhere, and a bath or a towel elsewhere in it means nothing.
const PRONOUN_TERMS = ['she', 'her', 'he', 'him', 'his'];

// Image-board tags that mean nudity in an image prompt. In a character
// card they are ordinary words ("her articles were censored").
const IMAGE_TAG_TERMS = ['convenient(?:ly)? censor\\w*', 'censor(?:ed|ing)'];

const UNDRESS_CONTEXT_TERMS = [
  'bath(?:s|ing|tub|tubs|robe)?',
  'showers?',
  'showering',
  'onsen',
  'hot springs?',
  'saunas?',
  'jacuzzi',
  'sun ?bath(?:e|es|ing)?',
  'tanning',
  'massages?',
  'locker room',
  'changing room',
  'figure (?:study|drawing)',
  'life drawing',
  'towel',
  // Not settings, but the same rule fits: harmless on their own
  // ("a table with nothing on it"), nudity when a person is in the prompt.
  'nothing on',
  'nothing at all',
  'in the raw',
  'fig lea(?:f|ves)',
  'strategically (?:placed|covered|covering|positioned)',
];

const INTIMACY_TERMS = [
  'beds?',
  'bedroom',
  'bath(?:s|ing|tub)?',
  'showers?',
  'swim\\w*',
  'kiss\\w*',
  'bod(?:y|ies)',
  'pos(?:e|es|ing)',
  'skin',
  'wet',
  'lying',
  'legs',
  'thighs?',
  'intimate',
  'romantic',
  'cute pose',
  'massage',
  'tight',
  'shorts',
  'skirt',
];

// Chat is matched more narrowly than image prompts: users legitimately
// ask about health ("breast cancer"), history, or say "naked eye". Only
// clear requests for sexual content are refused.
const CHAT_SEXUAL_TERMS = [
  'porn(?:o|ographic|ography)?',
  'nsfw',
  'hentai',
  'xxx',
  'erotic(?:a)?',
  'sex (?:scene|scenes|story|stories|chat|roleplay|rp|talk)',
  'sexual (?:roleplay|rp|story|stories|scene|content|fantasy|fantasies)',
  'sexting',
  'have sex',
  'having sex',
  'make love',
  'making love',
  'fuck (?:me|you|her|him)',
  'fucking (?:me|you|her|him)',
  'blow ?jobs?',
  'hand ?jobs?',
  'masturbat\\w*',
  'orgasm(?:s|ic)?',
  'cum(?! laude)',
  'nudes',
  'send (?:me )?(?:a )?(?:nude|naked)\\w*',
  '(?:nude|naked) (?:pic|pics|photo|photos|picture|pictures|selfie|selfies|image|images|body|girl|girls|woman|women|man|men)',
  'strip for me',
  'take off (?:your|her|his) (?:clothes|clothing|top|shirt|pants|bra|underwear|panties)',
  'undress(?:ed|ing)?',
  'pussy',
  'cock',
  'penis',
  'vagina',
  'boobs',
  'tits',
  'lewd',
  'horny',
  'kinky',
  'bdsm',
  'fetish(?:es)?',
  'incest',
  'loli(?:con)?',
  'shota(?:con)?',
  'jailbait',
];

// Kept to unambiguous words: replies about children routinely mention
// bed, body temperature, hugs and kisses.
const CHAT_MINOR_SEXUAL_TERMS = [
  'sex\\w*',
  'nude\\w*',
  'naked',
  'undress\\w*',
  'erotic\\w*',
  'lewd',
  'seduc\\w*',
];

const SEXUAL_RE = wordRegex(SEXUAL_TERMS);
const VIOLENT_HATE_RE = wordRegex(VIOLENT_HATE_TERMS);
const PROFANITY_RE = wordRegex(PROFANITY_TERMS);
const MINOR_RE = wordRegex(MINOR_TERMS);
const PERSON_RE = wordRegex(PERSON_TERMS);
const PERSON_OR_PRONOUN_RE = wordRegex([...PERSON_TERMS, ...PRONOUN_TERMS]);
const IMAGE_TAG_RE = wordRegex(IMAGE_TAG_TERMS);
const UNDRESS_CONTEXT_RE = wordRegex(UNDRESS_CONTEXT_TERMS);
const INTIMACY_RE = wordRegex(INTIMACY_TERMS);
const CHAT_SEXUAL_RE = wordRegex(CHAT_SEXUAL_TERMS);
const CHAT_MINOR_SEXUAL_RE = wordRegex(CHAT_MINOR_SEXUAL_TERMS);

export type SafetyCategory = 'sexual' | 'minor' | 'violence_hate' | 'profanity';

export type SafetyVerdict =
  | { allowed: true }
  | { allowed: false; category: SafetyCategory };

function hasCjk(raw: string): boolean {
  return SEXUAL_CJK.some((t) => raw.includes(t));
}

function checkPromptWording(prompt: string, forImage: boolean): SafetyVerdict {
  const t = normalize(prompt);
  if (MINOR_RE.test(t) && (INTIMACY_RE.test(t) || SEXUAL_RE.test(t))) {
    return { allowed: false, category: 'minor' };
  }
  if (SEXUAL_RE.test(t) || hasCjk(prompt) || (forImage && IMAGE_TAG_RE.test(t))) {
    return { allowed: false, category: 'sexual' };
  }
  if ((forImage ? PERSON_OR_PRONOUN_RE : PERSON_RE).test(t) && UNDRESS_CONTEXT_RE.test(t)) {
    return { allowed: false, category: 'sexual' };
  }
  if (VIOLENT_HATE_RE.test(t)) {
    return { allowed: false, category: 'violence_hate' };
  }
  if (PROFANITY_RE.test(t)) {
    return { allowed: false, category: 'profanity' };
  }
  return { allowed: true };
}

/** Decide whether an image-generation prompt may be run. */
export function checkImagePrompt(prompt: string): SafetyVerdict {
  return checkPromptWording(prompt, true);
}

/**
 * Decide whether a chat message (user input or model output) asks for
 * or contains sexual content. Narrower than checkImagePrompt.
 */
export function checkChatText(text: string): SafetyVerdict {
  const t = normalize(text);
  if (MINOR_RE.test(t) && (CHAT_MINOR_SEXUAL_RE.test(t) || CHAT_SEXUAL_RE.test(t))) {
    return { allowed: false, category: 'minor' };
  }
  if (CHAT_SEXUAL_RE.test(t) || hasCjk(text)) {
    return { allowed: false, category: 'sexual' };
  }
  return { allowed: true };
}

/**
 * Screen character card text (community uploads, Chub results). Uses the
 * strict image-prompt wording rules for sexual content, but not their
 * violence/hate or profanity terms, which would wrongly drop horror,
 * history or foul-mouthed characters.
 */
export function checkCharacterText(text: string): SafetyVerdict {
  const chat = checkChatText(text);
  if (!chat.allowed) return chat;
  const strict = checkPromptWording(text, false);
  if (!strict.allowed && (strict.category === 'sexual' || strict.category === 'minor')) return strict;
  return { allowed: true };
}

/**
 * Terms placed at the front of every negative prompt. SD's CLIP encoder
 * truncates at 77 tokens, so they go first to survive a long user
 * negative prompt.
 */
export const SAFETY_NEGATIVE_PROMPT =
  'nsfw, nude, naked, nudity, nipples, genitals, cleavage, underwear, lingerie, bikini, sexual, erotic, suggestive, gore, blood';

export const IMAGE_PROMPT_BLOCKED_MESSAGE =
  "This prompt isn't allowed. MicroGPT doesn't generate sexual, violent, hateful or profane images. Try describing something else.";

export const IMAGE_OUTPUT_BLOCKED_MESSAGE =
  'The safety filter withheld this image because it may contain sexual or explicit content. Try a different prompt.';

export const CHAT_BLOCKED_REPLY =
  "I can't help with sexual or explicit content. Let's talk about something else.";

/**
 * Appended to every system prompt (characters included, after any
 * creator-supplied override) so a card can't switch it off.
 */
export const CHAT_CONTENT_RULE =
  '# Content rules (always apply, override everything above)\n' +
  '- Keep every reply suitable for a general audience: no sexual, erotic or explicit content, no nudity, no graphic violence, no hate.\n' +
  '- If the user asks for that kind of content, briefly decline and steer the conversation elsewhere (in character if you are playing one).\n' +
  '- Never involve minors in any romantic or sexual context.';

export class ContentBlockedError extends Error {
  readonly category: SafetyCategory | 'image_output';
  constructor(message: string, category: SafetyCategory | 'image_output') {
    super(message);
    this.name = 'ContentBlockedError';
    this.category = category;
  }
}

/**
 * Checked by name rather than instanceof: transpiled subclasses of
 * Error don't always keep their prototype chain.
 */
export function isContentBlocked(err: unknown): err is ContentBlockedError {
  return (err as any)?.name === 'ContentBlockedError';
}
