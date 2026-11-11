export function isAssessment(url: string): boolean {
  return /\/(?:assessment|assessments)(?:\/|$)/i.test(new URL(url).pathname);
}

export function selectorProfile(url: string): string {
  const { origin, pathname } = new URL(url);
  const section = isAssessment(url) ? 'assessment'
    : /\/topicFeed(?:\/|$)/i.test(pathname) ? 'topicFeed'
    : pathname.replace(/\/$/, '');
  return 'beyimSelectors:' + origin + '/' + section;
}
