FROM node:14

RUN mkdir -p /usr/src/app

RUN apt-get update

RUN apt-get install -y build-essential

# ENV ROOT_URL="http://localhost:3000"
ENV ROOT_URL="https://claychallengefront-production.up.railway.app"

RUN curl "https://install.meteor.com/" | sh

WORKDIR /usr/src/app

RUN npm install -g meteor
 

COPY . /usr/src/app

RUN chmod -R 700 /usr/src/app/.meteor/local

RUN meteor npm install

EXPOSE 3000
CMD ["npm", "start"]
