import { buildSchema } from 'graphql';

export const platformSchema = buildSchema(`
  type MenuItem {
    id: ID!
    name: String!
    price: String!
  }
  type OrderRow {
    id: ID!
    number: String!
    status: String!
    total: String!
  }
  type CustomerRow {
    id: ID!
    name: String
    phone: String
  }
  type Score {
    branchId: ID!
    name: String!
    orders: Int!
    sales: String!
    aov: String!
    covers: Int!
    noShows: Int!
  }
  type Device {
    id: ID!
    name: String!
    online: Boolean!
    version: String
    lastSeenAt: String
  }
  type Query {
    menu(branchId: ID!): [MenuItem!]!
    openOrders(branchId: ID!): [OrderRow!]!
    customer(branchId: ID!, id: ID!): CustomerRow
    scoreboard: [Score!]!
    devices(branchId: ID!): [Device!]!
  }
  type Mutation {
    recallTicket(branchId: ID!, kotId: ID!): Boolean!
  }
`);
