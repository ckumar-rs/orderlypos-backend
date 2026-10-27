import {
  asksForPrivateContact,
  filterTools,
  renderAnswer,
  replyStaysInside,
  toolsForQuestion,
} from './agent-plan';

describe('toolsForQuestion', () => {
  it('checks the branch when the question is open', () => {
    expect(toolsForQuestion('What is happening?', 'branch')).toEqual([
      'sales_today',
      'sales_month',
      'open_orders',
      'late_tickets',
      'low_stock',
      'reservations_today',
    ]);
  });

  it('adds the comparison only for the restaurant agent', () => {
    expect(toolsForQuestion('Compare the other branches', 'branch')).not.toContain('branch_comparison');
    expect(toolsForQuestion('Compare the other branches', 'restaurant')).toContain('branch_comparison');
  });

  it('keeps a sales question on sales', () => {
    expect(toolsForQuestion('How were sales today?', 'branch')).toEqual(['sales_today']);
  });
});

describe('filterTools', () => {
  it('drops kitchen tickets when the login cannot see the kitchen', () => {
    const result = filterTools(['sales_today', 'late_tickets'], ['dashboard.sales.view'], 'branch');
    expect(result.allowed).toEqual(['sales_today']);
    expect(result.skipped[0]).toContain('kitchen');
  });
});

describe('renderAnswer', () => {
  it('prints the paid total and refuses a contact detail', () => {
    const text = renderAnswer({
      branches: [
        {
          branchName: 'Main',
          salesToday: { orders: 2, total: '60.00' },
          openOrders: [],
        },
      ],
      skipped: [],
      privateContact: true,
      otherBranchesFromBranchChat: false,
    });
    expect(text).toContain('2 paid orders, 60.00');
    expect(text).toContain('Open orders: none.');
    expect(text).toContain('allergy notes are not included');
    expect(asksForPrivateContact('what is her phone')).toBe(true);
  });
});

describe('replyStaysInside', () => {
  const records = 'Today: 2 paid orders, 60.00.';

  it('accepts a sentence that repeats the records', () => {
    expect(replyStaysInside('Two orders today, total 60.00.', records)).toBe(true);
  });

  it('rejects a number the records did not print', () => {
    expect(replyStaysInside('About 100 in sales.', records)).toBe(false);
  });
});
