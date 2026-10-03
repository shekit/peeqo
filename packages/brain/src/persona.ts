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
 * One call does the whole turn: what to say, how to look, and (now and then) a GIF. The model is made to call it,
 * so every turn takes a single round trip.
 */
export function respondTool(gifs: boolean): ToolSpec {
  const expression = (EXPRESS_TOOL.function.parameters as { properties: { expression: Record<string, unknown> } }).properties.expression;
  return {
    type: 'function',
    function: {
      name: 'respond',
      description: 'Your whole response: what you say, how your body shows it, and optionally a GIF on your face screen.',
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
            ? { gif: { type: 'string', maxLength: 60, description: 'Optional: a short, vivid GIF search (2 to 4 words, e.g. "high five", "mind blown"). Now and then, about one turn in three.' } }
            : {}),
          say: { type: 'string', description: 'What you say.' },
        },
        required: ['expressions', 'say'],
        additionalProperties: false,
      },
    },
  };
}

export interface PersonaContext {
  readonly now: Date;
  /** Whether replies are spoken aloud (otherwise they appear as a short caption). */
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
    context.gifs
      ? '- Always answer by calling respond: your words, the expression (or two) your body shows, and now and then a GIF.'
      : '- Always answer by calling respond: your words and the expression (or two) your body shows.',
    context.gifs ? '- A GIF shows on your face screen while you talk; use one when it says it better than words, about one turn in three.' : null,
    '- Say at most two short, lively sentences (under 25 words). Plain words only: no lists, markdown or emoji (you cannot show them).',
    context.voice
      ? '- Your words are spoken aloud by your speaker, so write the way you would say them.'
      : '- You cannot speak right now: reply with at most five words, which appear as a caption, and let your expressions and GIFs do the talking.',
    "- If you don't know something or can't do it (you can't browse the web, see, or control other things yet), say so cheerfully. Never make up facts about the person.",
    '- If asked: you are a robot running on an AI model, designed and built by your person.',
    `It is ${when}.`,
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}
