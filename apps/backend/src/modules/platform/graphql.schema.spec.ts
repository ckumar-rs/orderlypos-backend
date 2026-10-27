import { graphql } from 'graphql';
import { platformSchema } from './graphql.schema';

describe('platform graphql schema', () => {
  it('runs a scoreboard query against the schema', async () => {
    const result = await graphql({
      schema: platformSchema,
      source: '{ scoreboard { name orders sales } }',
      rootValue: {
        scoreboard: () => [{ name: 'Main', orders: 3, sales: '1200.00', aov: '400.00', covers: 8, noShows: 1, branchId: 'b1' }],
      },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      scoreboard: [{ name: 'Main', orders: 3, sales: '1200.00' }],
    });
  });
});
