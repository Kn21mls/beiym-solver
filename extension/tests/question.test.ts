import { describe, expect, it } from 'vitest';
import { AnswerFormatError, SolverError } from '../src/shared/errors';
import { answerSchema, fingerprint, prompt, validateAnswer } from '../src/shared/question';
import type { Question } from '../src/shared/types';

const single: Question = {
  text: '2 + 2 = ?',
  options: [
    { text: '4', selector: '#a' },
    { text: '5', selector: '#b' },
  ],
  kind: 'single',
  root: '#root',
  input_selector: '',
  has_image: false,
  adapter: 'generic',
  submit_selector: '',
  carousel_selector: '',
};

const textQuestion: Question = {
  ...single,
  text: 'Столица Франции?',
  options: [],
  kind: 'text',
  input_selector: '#answer',
};

describe('answerSchema', () => {
  it('constrains single choice ids and empty text', () => {
    const schema = answerSchema(single);
    expect(schema.properties.answer_ids.items.enum).toEqual([1, 2]);
    expect(schema.properties.answer_ids.maxItems).toBe(1);
    expect(schema.properties.text_answer.enum).toEqual(['']);
  });

  it('requires text for text questions', () => {
    const schema = answerSchema(textQuestion);
    expect(schema.properties.answer_ids.maxItems).toBe(0);
    expect(schema.properties.text_answer.minLength).toBe(1);
  });
});

describe('validateAnswer', () => {
  it('accepts a valid single answer', () => {
    const answer = validateAnswer(
      { answer_ids: [1], text_answer: '', explanation: 'ok', confidence: 0.9, needs_help: false },
      single,
      0.8,
    );
    expect(answer.answer_ids).toEqual([1]);
  });

  it('rejects low confidence', () => {
    expect(() =>
      validateAnswer(
        { answer_ids: [1], text_answer: '', explanation: 'ok', confidence: 0.4, needs_help: false },
        single,
        0.8,
      ),
    ).toThrow(SolverError);
  });

  it('rejects an out-of-range id', () => {
    expect(() =>
      validateAnswer(
        { answer_ids: [3], text_answer: '', explanation: 'ok', confidence: 0.9, needs_help: false },
        single,
        0.8,
      ),
    ).toThrow(AnswerFormatError);
  });

  it('accepts a text answer', () => {
    const answer = validateAnswer(
      { answer_ids: [], text_answer: 'Париж', explanation: 'ok', confidence: 0.9, needs_help: false },
      textQuestion,
      0.8,
    );
    expect(answer.text_answer).toBe('Париж');
  });
});

describe('prompt and fingerprint', () => {
  it('includes numbered options', () => {
    expect(JSON.parse(prompt(single)).options).toEqual([
      { id: 1, text: '4' },
      { id: 2, text: '5' },
    ]);
  });

  it('is stable for the same question', async () => {
    expect(await fingerprint(single)).toBe(await fingerprint({ ...single }));
  });
});
