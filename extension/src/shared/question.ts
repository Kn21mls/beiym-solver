import { AnswerFormatError, SolverError } from './errors';
import type { Answer, Question } from './types';

type Schema = {
  type: string;
  properties: Record<string, any>;
  required: string[];
  additionalProperties: boolean;
};

export const ANSWER_SCHEMA: Schema = {
  type: 'object',
  properties: {
    answer_ids: { type: 'array', items: { type: 'integer' } },
    text_answer: { type: 'string' },
    explanation: { type: 'string' },
    confidence: { type: 'number' },
    needs_help: { type: 'boolean' },
  },
  required: ['answer_ids', 'text_answer', 'explanation', 'confidence', 'needs_help'],
  additionalProperties: false,
};

export function answerSchema(question: Question): Schema {
  const schema = JSON.parse(JSON.stringify(ANSWER_SCHEMA)) as Schema;
  const properties = schema.properties;
  const explanation = properties.explanation;
  schema.properties = { explanation, ...properties };
  const ids = properties.answer_ids;
  if (question.kind === 'text') {
    ids.minItems = 0;
    ids.maxItems = 0;
    properties.text_answer.minLength = 1;
  } else if (question.options.length > 0) {
    ids.items.enum = Array.from({ length: question.options.length }, (_, index) => index + 1);
    ids.minItems = 1;
    ids.maxItems = question.kind === 'single' ? 1 : question.options.length;
    ids.uniqueItems = true;
    properties.text_answer.enum = [''];
  } else {
    throw new SolverError('Неизвестный тип задания или отсутствуют варианты.');
  }
  properties.confidence.minimum = 0;
  properties.confidence.maximum = 1;
  return schema;
}

export function validateAnswer(value: unknown, question: Question, threshold: number): Answer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AnswerFormatError('Модель вернула неверную структуру ответа.');
  }
  const answer = value as Record<string, unknown>;
  const required = ANSWER_SCHEMA.required;
  if (Object.keys(answer).length !== required.length || required.some((key) => !(key in answer))) {
    throw new AnswerFormatError('Модель вернула неверную структуру ответа.');
  }

  const confidence = answer.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new AnswerFormatError('Некорректная уверенность модели.');
  }
  if (typeof answer.needs_help !== 'boolean' || typeof answer.explanation !== 'string') {
    throw new AnswerFormatError('Некорректные поля ответа модели.');
  }
  if (answer.needs_help || confidence < threshold) {
    throw new SolverError(`Модель не уверена (${Math.round(confidence * 100)}%). ${answer.explanation}`);
  }

  const ids = answer.answer_ids;
  if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id))) {
    throw new AnswerFormatError('Модель вернула некорректные номера вариантов.');
  }
  if (new Set(ids).size !== ids.length || ids.some((id) => id < 1 || id > question.options.length)) {
    throw new AnswerFormatError('Номер ответа отсутствует в задании или повторяется.');
  }
  if (typeof answer.text_answer !== 'string') {
    throw new AnswerFormatError('Текст ответа должен быть строкой.');
  }
  if (question.kind === 'single' && ids.length !== 1) {
    throw new AnswerFormatError('Для этого задания нужен ровно один вариант.');
  }
  if (question.kind === 'multiple' && ids.length === 0) {
    throw new AnswerFormatError('Модель не выбрала ни одного варианта.');
  }
  if (question.kind === 'text' && (ids.length > 0 || !answer.text_answer.trim())) {
    throw new AnswerFormatError('Для этого задания нужен текстовый ответ.');
  }
  if (question.options.length > 0 && answer.text_answer.trim()) {
    throw new AnswerFormatError('Для выбора вариантов text_answer должен быть пустым.');
  }
  return answer as unknown as Answer;
}

export function prompt(question: Question): string {
  return JSON.stringify({
    question: question.text,
    type: question.kind,
    options: question.options.map((option, index) => ({ id: index + 1, text: option.text })),
  });
}

export async function fingerprint(question: Question): Promise<string> {
  const data = JSON.stringify([question.text, question.kind, question.options.map((option) => option.text)]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
