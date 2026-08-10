FROM node:22-alpine

# The addon shells out to curl to fetch gdflix pages
RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=7000

EXPOSE 7000

CMD ["node", "server.js"]
