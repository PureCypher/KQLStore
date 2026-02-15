FROM node:22-alpine AS build
WORKDIR /build
RUN npm init -y && npm install --save-dev @babel/core @babel/cli @babel/preset-react
COPY KQLStore.jsx KQLStoreTests.jsx ./
RUN echo '{"presets":[["@babel/preset-react",{"runtime":"classic"}]]}' > .babelrc \
    && npx babel KQLStore.jsx -o KQLStore.js \
    && npx babel KQLStoreTests.jsx -o KQLStoreTests.js

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html tests.html /usr/share/nginx/html/
COPY --from=build /build/KQLStore.js /build/KQLStoreTests.js /usr/share/nginx/html/
USER 101
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
