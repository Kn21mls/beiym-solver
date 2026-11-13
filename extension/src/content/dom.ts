import { SolverError } from '../shared/errors';

export function visible(element: Element | null): boolean {
  return !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

export function all(root: ParentNode, selector: string): Element[] {
  return selector ? [...root.querySelectorAll(selector)].filter(visible) : [];
}

export function text(element: Element | null | undefined): string {
  const value = (element as HTMLElement | null)?.innerText || element?.textContent || '';
  return value.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

export function unique(root: ParentNode, selector: string): Element {
  const found = all(root, selector);
  if (found.length !== 1) {
    throw new SolverError(`Селектор «${selector}»: найдено ${found.length}, нужен один элемент.`);
  }
  return found[0];
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
