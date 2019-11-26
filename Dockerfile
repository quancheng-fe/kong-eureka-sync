FROM node:12-alpine

ADD package.json .

RUN yarn

ADD index.js .
ADD template.yaml.mustache .

CMD ["node", "index.js"]