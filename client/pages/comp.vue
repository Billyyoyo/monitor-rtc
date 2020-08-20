<template>
    <div class="hello">Hello {{who}}, {{value}}</div>
</template>

<script>

    module.exports = {
        props: ['value'],
        data: function () {
            return {
                who: 'world'
            }
        },
        mounted() {
            this.$emit('on-comp-created')
        },
        destroyed() {
        }
    }
</script>

<style scoped>
    .hello {
        background-color: red;
    }
</style>