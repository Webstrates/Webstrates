# Start from a small Alpine Linux base image
FROM node:20-alpine

# The 'git' dependency is needed for some npm packages
RUN apk add --no-cache git

# Fetch dependencies for Webstrates
COPY /package*.json /app/
WORKDIR /app
RUN npm install
COPY . /app
#RUN npm run build

# Build and run the server when "up"
EXPOSE 7007
CMD ["npm", "start"]

