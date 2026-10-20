CREATE TABLE "ReadCursor" (
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "lastReadSequence" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ReadCursor_pkey" PRIMARY KEY ("userId", "channelId"),
    CONSTRAINT "ReadCursor_sequence_nonnegative" CHECK ("lastReadSequence" >= 0)
);

CREATE INDEX "ReadCursor_channelId_idx" ON "ReadCursor"("channelId");

ALTER TABLE "ReadCursor" ADD CONSTRAINT "ReadCursor_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReadCursor" ADD CONSTRAINT "ReadCursor_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
