-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "clientMessageId" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Message_sequence_positive" CHECK ("sequence" > 0),
    CONSTRAINT "Message_body_nonempty" CHECK (char_length("body") > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "Message_authorId_clientMessageId_key" ON "Message"("authorId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_channelId_sequence_key" ON "Message"("channelId", "sequence");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
