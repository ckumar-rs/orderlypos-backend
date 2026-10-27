-- Generic "Other" tender (cheque, coupon, aggregator settlement…) alongside CASH/CARD/UPI.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'OTHER';
