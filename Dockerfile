FROM node:14-alpine

RUN apk add --update-cache git \
	&& rm -rf /var/cache/apk/*

COPY /package*.json /app/
WORKDIR /app
RUN npm install --production

COPY . /app
RUN npm run build

EXPOSE 7007

CMD node webstrates.js
