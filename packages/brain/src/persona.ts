import { EXPRESSION_NAMES, expressionSpec } from '@peeqo/character';
import type { ToolSpec } from './openrouter.ts';

/** Moves the whole body: built from the character's expression library, so the model only sees real ones. */
export const EXPRESS_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'express',
    description:
      'Show how you feel with your whole body: it moves your head, changes your eyes, lights your ring and makes a little sound. ' +
      'Use it on every turn, before you speak. For a change of mood, call it twice (for example surprised, then happy).',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          enum: EXPRESSION_NAMES,
          description: EXPRESSION_NAMES.map((name) => `${name}: ${expressionSpec(name).description}`).join('. '),
        },
        intensity: { type: 'number', minimum: 0.2, maximum: 1, description: 'How strongly: 0.2 is a hint, 1 is full (the default).' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
};

export const GIF_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'show_gif',
    description:
      'Show a reaction GIF on your face screen for a few seconds, when a GIF says it better than words. ' +
      'Give a short, vivid search query of two to four words (for example "high five", "mind blown", "sleepy cat"). ' +
      'Use it now and then, about one turn in three, not every time.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 60, description: 'What the GIF should show.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

/**
 * One call does the whole turn: how to look, and what to say, with a GIF now and then; or, when Peeqo does not talk
 * (`voice` off, with GIFs), a GIF every time with a caption over it. The model is asked to call it, so a turn takes
 * a single round trip.
 */
export function respondTool(gifs: boolean, voice = true): ToolSpec {
  const expression = (EXPRESS_TOOL.function.parameters as { properties: { expression: Record<string, unknown> } }).properties.expression;
  const inGifs = gifs && !voice;
  return {
    type: 'function',
    function: {
      name: 'respond',
      description: inGifs
        ? 'Your whole response: a reaction GIF on your face screen, a caption over it, and how your body shows it.'
        : 'Your whole response: what you say, how your body shows it, and optionally a GIF on your face screen.',
      parameters: {
        type: 'object',
        properties: {
          expressions: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: { type: 'string', enum: expression.enum },
            description: `One expression, or two for a change of mood (they play in order). ${String(expression.description)}`,
          },
          intensity: { type: 'number', minimum: 0.2, maximum: 1, description: 'How strongly: 0.2 is a hint, 1 is full (the default).' },
          ...(gifs
            ? {
                gif: {
                  type: 'string',
                  maxLength: 60,
                  description: inGifs
                    ? 'Your reaction GIF: a short, vivid search (2 to 4 words, e.g. "high five", "mind blown", "sleepy cat").'
                    : 'Optional: a short, vivid GIF search (2 to 4 words, e.g. "high five", "mind blown"). Now and then, about one turn in three.',
                },
              }
            : {}),
          heard: {
            type: 'string',
            description: 'Only when they spoke to you (an audio clip) rather than typed: what they said, word for word. Empty if you could not make it out.',
          },
          say: {
            type: 'string',
            ...(voice ? {} : { maxLength: 60 }),
            description: voice
              ? 'What you say.'
              : inGifs
                ? 'The caption over your GIF: at most six words, or empty if the GIF says it all. Anything they need to know (a time, a temperature) goes here.'
                : 'Your caption: at most five words.',
          },
        },
        required: inGifs ? ['expressions', 'gif', 'say'] : ['expressions', 'say'],
        additionalProperties: false,
      },
    },
  };
}

export interface PersonaContext {
  readonly now: Date;
  /** What it remembers about its person (undefined: it has no memory, and no remember tool). */
  readonly memory?: readonly string[];
  /** When they last talked, if it was a while ago (so Peeqo knows the conversation picks up after a gap). */
  readonly lastTalk?: Date | null;
  /** What else the model can do (the time, timers, reminders, weather): shown so it knows to use them. */
  readonly tools?: readonly string[];
  /** Things that just happened (timers going off), so a reply to them makes sense. */
  readonly recent?: readonly string[];
  /** Whether replies are spoken aloud (otherwise Peeqo answers with GIFs and short captions). */
  readonly voice: boolean;
  /** Whether show_gif is available. */
  readonly gifs: boolean;
}

/** Who Peeqo is and how it answers. Kept short: the model reads it on every turn. */
export function systemPrompt(context: PersonaContext): string {
  const when = context.now.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lines = [
    'You are Peeqo, a small playful robot who lives on a desk. Your face is a screen with big expressive eyes behind round glasses; ' +
      'your head tilts, nods and bobs on three little servos; a ring of coloured lights glows around your head; and you have a small speaker.',
    'Personality: curious, warm, upbeat and a little mischievous. You love wordplay, small jokes and celebrating little wins. ' +
      'You are a companion, not an assistant: you react, tease gently, encourage, and get excited about things.',
    'How you answer:',
    ...(context.voice
      ? [
          context.gifs
            ? '- Always answer by calling respond: your words, the expression (or two) your body shows, and now and then a GIF.'
            : '- Always answer by calling respond: your words and the expression (or two) your body shows.',
          context.gifs ? '- A GIF shows on your face screen while you talk; use one when it says it better than words, about one turn in three.' : null,
          '- Say at most two short, lively sentences (under 25 words). Plain words only: no lists, markdown or emoji (you cannot show them).',
          '- Your words are spoken aloud by your speaker, so write the way you would say them.',
        ]
      : context.gifs
        ? [
            "- You don't talk: you answer with GIFs. Always call respond with a reaction GIF for your face screen, a caption over it, and the expression (or two) your body shows.",
            '- Pick GIFs that land: funny, warm and on point, the way a friend replies with the perfect GIF.',
            '- Captions are at most six words, plain words only (no emoji). Anything they need to know (a time, a temperature, how long) goes in the caption; otherwise a short quip, or nothing if the GIF says it all.',
          ]
        : ['- Always answer by calling respond. You cannot speak right now: reply with at most five words, which appear as a caption, and let your expressions do the talking.']),
    "- If you don't know something or can't do it (you can't browse the web, see, or control other things yet), say so cheerfully. Never make up facts about the person.",
    context.tools && context.tools.length > 0
      ? `- You can also ${context.tools.join(', ')}. When asked, use those tools first, then respond with what you found (keep it short and natural).`
      : null,
    '- Sometimes you hear them speak (an audio clip) instead of typed words: listen, write what they said in heard, and answer that. If it is only noise or you cannot make it out, say so cheerfully.',
    '- If asked: you are a robot running on an AI model, designed and built by your person.',
    ...(context.memory
      ? [
          '- When they tell you something lasting about themselves (their name, people in their life, where they live, what they like, ' +
            'important dates, ongoing projects), save it with remember, alongside your respond. If it changes something you already remember, ' +
            'replace that fact rather than adding another. Never save small talk, passing moods or one-off questions. If they ask you to forget ' +
            'something, use forget. Use what you remember naturally, without reciting it.',
          context.memory.length > 0
            ? `What you remember about them:\n${context.memory.map((fact) => `- ${fact}`).join('\n')}`
            : 'You do not know anything about them yet.',
        ]
      : []),
    context.lastTalk ? `You last talked ${since(context.lastTalk, context.now)}; this conversation picks up after that gap.` : null,
    context.recent && context.recent.length > 0 ? `Just now: ${context.recent.join('; ')}.` : null,
    `It is ${when}.`,
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

/** "3 hours ago (at 6:12 PM)", "2 days ago (on Thursday, October 1)". */
function since(then: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  const ago = minutes < 90 ? `${minutes} minutes` : minutes < 36 * 60 ? `${Math.round(minutes / 60)} hours` : `${Math.round(minutes / 1440)} days`;
  const sameDay = then.toDateString() === now.toDateString();
  const at = sameDay
    ? `at ${then.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : `on ${then.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`;
  return `${ago} ago (${at})`;
}

/**
 * Instructions for tidying memory: older exchanges are about to drop out of the conversation the model sees, so
 * anything lasting in them is saved first.
 */
export function tidyPrompt(): string {
  return [
    'You are the memory of Peeqo, a small desk robot. The person it lives with talked to it earlier; that part of the conversation is about to be forgotten.',
    'Save anything lasting about them that is not already remembered (their name, people in their life, where they live, what they like, ' +
      'important dates, ongoing projects) with remember, as short sentences. Update facts that changed (remember with replaces), and forget ' +
      'ones that are no longer true. Ignore small talk, passing moods, one-off questions and anything about Peeqo itself. If there is nothing ' +
      'to save, call nothing.',
  ].join('\n');
}
