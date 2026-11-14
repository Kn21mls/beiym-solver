import type { Answer, Question } from './types';

export type ContentRequest =
  | { type: 'extract' }
  | { type: 'apply'; question: Question; answer: Answer }
  | { type: 'advance'; question: Question }
  | { type: 'prepare' }
  | { type: 'beta-prepare'; operation: string }
  | { type: 'beta-submit'; operation: string; question: Question; answer: Answer }
  | { type: 'assessment-step'; operation: string; question: Question; answer: Answer }
  | { type: 'beta-select'; operation: string; question: Question; answer: Answer }
  | { type: 'beta-cancel'; operation: string }
  | { type: 'complete' }
  | { type: 'image'; question: Question; max: number };

export type ContentResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; cancelled?: boolean };

export interface PanelMessage {
  type: 'content';
  request: ContentRequest;
}

export interface CaptureRequest {
  type: 'capture';
}

export type CaptureResponse = { ok: true; dataUrl: string } | { ok: false; error: string };

export interface ImageResult {
  dataUrl: string;
  width: number;
  height: number;
}

export interface AdvanceResult {
  state: 'question' | 'complete';
  question?: Question;
}

export type { Answer };
