FROM node:26-bookworm-slim

WORKDIR /app/services/location-worker

COPY services/location-worker/package.json services/location-worker/package-lock.json ./
RUN npm ci

COPY services/location-worker/ ./
RUN npm run build

CMD ["npm", "start"]
