export type QuestionKind = 'single' | 'multiple' | 'text';
export type Adapter = 'generic' | 'beyim-activity';

export interface Option {
  text: string;
  selector: string;
  label_selector?: string;
  kind?: string;
  group?: string;
  disabled?: boolean;
}

export interface Question {
  text: string;
  options: Option[];
  kind: QuestionKind;
  root: string;
  input_selector: string;
  has_image: boolean;
  adapter: Adapter;
  submit_selector: string;
  carousel_selector: string;
  revision?: string;
}

export interface Answer {
  answer_ids: number[];
  text_answer: string;
  explanation: string;
  confidence: number;
  needs_help: boolean;
}

export interface Selectors {
  root: string;
  question: string;
  options: string;
  input: string;
  submit: string;
  next: string;
  complete: string;
}

export interface Settings {
  api_url: string;
  groq_model: string;
  url: string;
  max_questions: number;
  min_confidence: number;
  timeout: number;
  thinking: boolean;
  transition_timeout: number;
  num_predict: number;
  selectors: Selectors;
}
