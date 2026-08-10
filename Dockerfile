FROM node:22-alpine

# addon shells out to curl to fetch gdflix pages
RUN apk add --no-cache curl \
    && npm cache clean --force

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=7000

EXPOSE 7000

CMD ["node", "server.js"]
