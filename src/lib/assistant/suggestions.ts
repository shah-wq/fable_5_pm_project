/** Starter questions in the empty panel, per role — what that role actually asks. */
export function suggestionsFor(role: string): string[] {
  switch (role) {
    case 'admin':
    case 'ops':
      return [
        'Give me the PM report',
        'Which projects are stuck in Permits, and why?',
        'What is blocking installs this week?',
        'Which customers are unhappy right now?',
      ];
    case 'finance':
      return [
        'What is the pipeline value by stage?',
        'How many projects completed this quarter, and the average days to complete?',
        'Show contract value by dealer for projects signed this year',
      ];
    case 'sales':
      return [
        'Who is quoted but not contacted in 7 days?',
        'What is in my deal pipeline, by stage?',
        'Which of my signed customers are in Survey?',
      ];
    case 'dealer':
      return [
        'Where are all my projects?',
        'Which of my projects are on hold, and why?',
        'What is still missing on my projects in Design?',
      ];
    default:
      return ['Which projects are in Design?', 'What is missing on my projects?'];
  }
}
